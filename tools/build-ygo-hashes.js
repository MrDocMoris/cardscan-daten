// Baut die Yu-Gi-Oh-Fingerabdruck-Datenbank (data/ygo.bin) aus allen Kartenbildern von YGOPRODeck.
// Inkrementell: bereits berechnete Bilder (data/ygo-hashes.json) werden nicht neu geladen.
// Aufruf: node tools/build-ygo-hashes.js [--limit N]
const fs = require('fs'), path = require('path');
const sharp = require('sharp');
const V = require('../vision.js');

const ROOT = path.join(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'data', 'ygo-hashes.json');
const BIN_PATH = path.join(ROOT, 'data', 'ygo.bin');
const limit = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
const CONCURRENCY = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchRetry(url, asBuffer, tries = 4) {
  for (let t = 1; t <= tries; t++) {
    try {
      const r = await fetch(url, {headers: {'User-Agent': 'CardScan-HashBuilder/1.0 (private, non-commercial)'}});
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return asBuffer ? Buffer.from(await r.arrayBuffer()) : await r.json();
    } catch (e) { if (t === tries) throw e; await sleep(1000 * t * t); }
  }
}

async function hashImage(buf) {
  const {data, info} = await sharp(buf).removeAlpha().raw().toBuffer({resolveWithObject: true});
  const G = V.gray(data, info.width, info.height, info.channels);
  const S = V.integral(G);
  const h = V.cardHash(S, {x: 0, y: 0, w: info.width, h: info.height}, 'ygo');
  return Buffer.from(h.buffer).toString('hex');
}

(async () => {
  fs.mkdirSync(path.dirname(JSON_PATH), {recursive: true});
  const known = fs.existsSync(JSON_PATH) ? JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) : {};
  console.log('Bekannt:', Object.keys(known).length);
  const all = await fetchRetry('https://db.ygoprodeck.com/api/v7/cardinfo.php', false);
  const jobs = [];
  for (const c of all.data) for (const im of (c.card_images || [])) {
    if (!known[im.id]) jobs.push({cardId: c.id, imageId: im.id, url: im.image_url});
  }
  console.log('Karten:', all.data.length, '– neue Bilder:', jobs.length);
  const todo = jobs.slice(0, limit);
  let done = 0, failed = 0;
  const t0 = Date.now();
  async function worker() {
    while (todo.length) {
      const j = todo.shift();
      try {
        const buf = await fetchRetry(j.url, true);
        if (!buf) { failed++; continue; }
        known[j.imageId] = [j.cardId, await hashImage(buf)];
      } catch (e) { failed++; console.log('Fehler', j.imageId, e.message); }
      done++;
      if (done % 500 === 0) {
        console.log(`${done} fertig (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
        fs.writeFileSync(JSON_PATH, JSON.stringify(known)); // Zwischenstand
      }
      await sleep(120);
    }
  }
  await Promise.all(Array.from({length: CONCURRENCY}, worker));
  // Nur Bilder behalten, die es noch gibt
  const valid = new Set(); for (const c of all.data) for (const im of (c.card_images || [])) valid.add(String(im.id));
  for (const k of Object.keys(known)) if (!valid.has(k)) delete known[k];
  fs.writeFileSync(JSON_PATH, JSON.stringify(known));
  const entries = Object.entries(known).map(([imageId, [cardId, hex]]) => ({cardId, imageId: +imageId, hash: new Uint32Array(new Uint8Array(Buffer.from(hex, 'hex')).buffer)}));
  fs.writeFileSync(BIN_PATH, Buffer.from(V.encodeDB(entries)));
  console.log(`Fertig: ${entries.length} Einträge, ${failed} Fehler, ${(fs.statSync(BIN_PATH).size / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e); process.exit(1); });
