// Baut die Fingerabdruck-Datenbanken für Magic (Scryfall, ein Bild je Artwork) und Pokémon (TCGdex).
// Inkrementell: bereits berechnete Bilder (data/<spiel>-hashes.json) werden nicht neu geladen.
// Ergebnis für die App: data/<spiel>.bin (Fingerabdrücke) + data/<spiel>-ids.json (Karten-IDs)
// Aufruf: node tools/build-hashes.js mtg|pkm [--limit N]
const fs = require('fs'), path = require('path');
const sharp = require('sharp');
const V = require('../vision.js');

const GAME = process.argv[2];
if (!['mtg', 'pkm'].includes(GAME)) { console.error('Spiel angeben: mtg oder pkm'); process.exit(1); }
const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'data', `${GAME}-hashes.json`);
const BIN_PATH = path.join(ROOT, 'data', `${GAME}.bin`);
const IDS_PATH = path.join(ROOT, 'data', `${GAME}-ids.json`);
const limit = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
const CONCURRENCY = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, asBuffer, tries = 4) {
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await fetch(url, {headers: {'User-Agent': 'TCG-Multiversum-HashBuilder/1.0 (private, non-commercial)', Accept: asBuffer ? '*/*' : 'application/json'}});
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return asBuffer ? Buffer.from(await r.arrayBuffer()) : await r.json();
    } catch (e) { if (t === tries) throw e; await sleep(1000 * t * t); }
  }
}
async function hashImage(buf) {
  const {data, info} = await sharp(buf).flatten({background: '#ffffff'}).removeAlpha().raw().toBuffer({resolveWithObject: true});
  const G = V.gray(data, info.width, info.height, info.channels);
  const S = V.integral(G);
  const h = V.cardHash(S, {x: 0, y: 0, w: info.width, h: info.height}, GAME);
  return Buffer.from(h.buffer).toString('hex');
}

// Liste aller Bilder: {id, group, set, number, url}
async function listMtg() {
  const bulk = await fetchRetry('https://api.scryfall.com/bulk-data', false);
  console.log('Bulk-Typen:', (bulk.data || []).map(b => b.type).join(', '));
  const ua = (bulk.data || []).find(b => b.type === 'unique_artwork') || (bulk.data || []).find(b => /unique.?art/i.test(b.type || b.name || ''));
  if(!ua) throw new Error('unique_artwork nicht gefunden: ' + JSON.stringify(bulk).slice(0, 400));
  console.log('Lade', ua.download_uri, Math.round(ua.size / 1e6), 'MB');
  const cards = await fetchRetry(ua.download_uri, false);
  const BAD_LAYOUT = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'scheme', 'planar', 'vanguard', 'reversible_card']);
  const BAD_SET = new Set(['token', 'memorabilia', 'minigame', 'alchemy', 'vanguard']);
  const out = [];
  for (const c of cards) {
    if (c.digital || !(c.games || []).includes('paper') || BAD_LAYOUT.has(c.layout) || BAD_SET.has(c.set_type)) continue;
    const face = c.card_faces && c.card_faces[0];
    const iu = c.image_uris || (face && face.image_uris);
    if (!iu || !iu.small) continue;
    out.push({id: c.id, group: c.oracle_id || (face && face.oracle_id) || c.name, name: c.name, set: c.set, number: c.collector_number, url: iu.small});
  }
  return out;
}
async function listPkm() {
  const cards = await fetchRetry('https://api.tcgdex.net/v2/en/cards', false);
  const out = [];
  for (const c of cards) {
    if (!c.image || /^(A\d|P-A|B\d)/i.test(c.id)) continue; // TCG Pocket auslassen
    out.push({id: c.id, group: c.name, name: c.name, set: c.id.replace(/-[^-]+$/, ''), number: c.localId, url: c.image + '/low.png'});
  }
  return out;
}

(async () => {
  fs.mkdirSync(path.dirname(JSON_PATH), {recursive: true});
  const known = fs.existsSync(JSON_PATH) ? JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) : {};
  console.log('Bekannt:', Object.keys(known).length);
  const all = GAME === 'mtg' ? await listMtg() : await listPkm();
  const jobs = all.filter(j => !known[j.id]);
  console.log('Bilder:', all.length, '– neu:', jobs.length);
  const todo = jobs.slice(0, limit);
  let done = 0, failed = 0;
  const t0 = Date.now();
  async function worker() {
    while (todo.length) {
      const j = todo.shift();
      try {
        const buf = await fetchRetry(j.url, true);
        if (!buf) { failed++; continue; }
        known[j.id] = await hashImage(buf);
      } catch (e) { failed++; if (failed < 30) console.log('Fehler', j.id, e.message); }
      done++;
      if (done % 1000 === 0) {
        console.log(`${done}/${jobs.length} fertig (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
        fs.writeFileSync(JSON_PATH, JSON.stringify(known));
      }
      await sleep(GAME === 'mtg' ? 60 : 40);
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  const valid = new Set(all.map(j => j.id));
  for (const k of Object.keys(known)) if (!valid.has(k)) delete known[k];
  fs.writeFileSync(JSON_PATH, JSON.stringify(known));
  // Gruppen (gleiche Karte, egal welcher Druck/Artwork) → Index; Einträge in Reihenfolge der Liste
  const groups = [], gIndex = new Map(), items = [], entries = [];
  for (const j of all) {
    const hex = known[j.id]; if (!hex) continue;
    if (!gIndex.has(j.group)) { gIndex.set(j.group, groups.length); groups.push(j.name); }
    const n = items.length;
    items.push([j.id, j.set, j.number]);
    entries.push({cardId: gIndex.get(j.group), imageId: n, hash: new Uint32Array(new Uint8Array(Buffer.from(hex, 'hex')).buffer)});
  }
  fs.writeFileSync(BIN_PATH, Buffer.from(V.encodeDB(entries)));
  fs.writeFileSync(IDS_PATH, JSON.stringify({date: new Date().toISOString(), groups, items}));
  // nur für die Validierung: Bild-Adressen
  fs.writeFileSync(path.join(ROOT, 'data', `${GAME}-urls.json`), JSON.stringify(Object.fromEntries(all.filter(j => known[j.id]).map(j => [j.id, j.url]))));
  console.log(`Fertig: ${entries.length} Einträge, ${groups.length} Karten, ${failed} Fehler, bin ${(fs.statSync(BIN_PATH).size / 1024).toFixed(0)} KB, ids ${(fs.statSync(IDS_PATH).size / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
