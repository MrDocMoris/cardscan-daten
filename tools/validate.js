// Prüft die Bilderkennung mit simulierten Handyfotos echter Karten und mit Magic-/Pokémon-Karten als Gegenprobe.
// Aufruf: node tools/validate.js [--n 300] [--neg 150] [--images DIR]
//   --images DIR: lokale Testbilder statt Download (Dateiname <imageId>.jpg; Unterordner neg/ für Gegenproben)
const fs = require('fs'), path = require('path');
const sharp = require('sharp');
const V = require('../vision.js');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const N = +arg('--n', 300), NEG = +arg('--neg', 150), IMGDIR = arg('--images', null);
const db = V.decodeDB(new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'data', 'ygo.bin'))).buffer);
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, buf) {
  for (let t = 1; t <= 3; t++) {
    try { const r = await fetch(url, {headers: {'User-Agent': 'CardScan-Validate/1.0'}}); if (!r.ok) throw new Error(r.status); return buf ? Buffer.from(await r.arrayBuffer()) : r.json(); }
    catch (e) { if (t === 3) return null; await sleep(800 * t); }
  }
}

// Simuliert ein Handyfoto: skalieren, drehen, Hintergrund, Unschärfe, Helligkeit, Reflex, JPEG
async function simulate(buf) {
  const m = await sharp(buf).metadata();
  const H = Math.round(520 + rnd() * 420), W = Math.round(m.width * H / m.height);
  const angle = (rnd() - 0.5) * 5;
  const bg = {r: Math.round(rnd() * 200), g: Math.round(rnd() * 180), b: Math.round(rnd() * 160), alpha: 1};
  let card = await sharp(buf).resize(W, H).modulate({brightness: 0.7 + rnd() * 0.55, saturation: 0.8 + rnd() * 0.4})
    .blur(0.3 + rnd() * 1.3).png().toBuffer();
  if (rnd() < 0.35) { // Lichtreflex
    const gx = Math.round(rnd() * W), gy = Math.round(rnd() * H), gr = Math.round(W * (0.15 + rnd() * 0.25)), a = (0.25 + rnd() * 0.35).toFixed(2);
    const svg = `<svg width="${W}" height="${H}"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff" stop-opacity="${a}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><circle cx="${gx}" cy="${gy}" r="${gr}" fill="url(#g)"/></svg>`;
    card = await sharp(card).composite([{input: Buffer.from(svg)}]).png().toBuffer();
  }
  const rot = await sharp(card).rotate(angle, {background: bg}).png().toBuffer();
  const rm = await sharp(rot).metadata();
  const pl = Math.round(W * (0.1 + rnd() * 0.25)), pr = Math.round(W * (0.1 + rnd() * 0.25)), pt = Math.round(H * (0.08 + rnd() * 0.15)), pb = Math.round(H * (0.08 + rnd() * 0.15));
  const out = await sharp(rot).extend({left: pl, right: pr, top: pt, bottom: pb, background: bg}).jpeg({quality: Math.round(45 + rnd() * 35)}).toBuffer();
  const {data, info} = await sharp(out).removeAlpha().raw().toBuffer({resolveWithObject: true});
  const cx = pl + rm.width / 2, cy = pt + rm.height / 2;
  return {data, info, truth: {x: cx - W / 2, y: cy - H / 2, w: W, h: H}};
}

function runPipeline(sim, useRefine) {
  const {data, info, truth} = sim;
  const G = V.gray(data, info.width, info.height, info.channels), S = V.integral(G);
  // Nutzer hält die Karte ungefähr in den Rahmen: Position ±4 %, Größe ±5 %, Rahmen evtl. im 63:88-Format (Auto-Modus)
  const guideAspect = rnd() < 0.5 ? V.ASPECT.ygo : V.ASPECT.mtg;
  const gh = truth.h * (1 + (rnd() - 0.5) * 0.10), gw = gh * guideAspect;
  const guess = {x: truth.x + truth.w / 2 - gw / 2 + (rnd() - 0.5) * 0.08 * truth.w, y: truth.y + truth.h / 2 - gh / 2 + (rnd() - 0.5) * 0.08 * truth.h, w: gw, h: gh};
  if (!useRefine) return {m: V.match(db, V.jitterHashes(S, guess, 'ygo')), rect: guess, guess};
  const fh = V.frameHashes(G, S, guess, 'ygo');
  return {m: V.match(db, fh.hashes), rect: fh.rect, guess};
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

(async () => {
  console.log('Datenbank:', db.count, 'Einträge');
  // --- Positive Proben ---
  let ids = [];
  if (IMGDIR) ids = fs.readdirSync(IMGDIR).filter(f => /^\d+\.(jpg|png)$/.test(f)).map(f => f);
  else { const all = Array.from(db.imageIds); for (let i = 0; i < N; i++) ids.push(all[Math.floor(rnd() * all.length)]); }
  const pos = {ref: [], raw: []};
  let i = 0;
  for (const id of ids.slice(0, N)) {
    const buf = IMGDIR ? fs.readFileSync(path.join(IMGDIR, id)) : await get(`https://images.ygoprodeck.com/images/cards/${id}.jpg`, true);
    if (!buf) continue;
    const imageId = parseInt(String(id), 10);
    const k = db.imageIds.indexOf(imageId); const cardId = k >= 0 ? db.cardIds[k] : -1;
    const sim = await simulate(buf);
    for (const mode of ['ref', 'raw']) {
      const savedSeed = seed;
      const {m, rect} = runPipeline(sim, mode === 'ref');
      if (mode === 'ref') seed = savedSeed; // gleicher Rahmen für beide Varianten
      pos[mode].push({ok: m && m.cardId === cardId, d: m ? m.dist : 99, margin: m ? m.margin : 0, refined: rect.refined});
    }
    if (++i % 50 === 0) console.log(i, 'Proben');
    if (!IMGDIR) await sleep(80);
  }
  // --- Gegenproben (Magic/Pokémon) ---
  const negs = [];
  let negUrls = [];
  if (IMGDIR && fs.existsSync(path.join(IMGDIR, 'neg'))) negUrls = fs.readdirSync(path.join(IMGDIR, 'neg')).map(f => ({file: path.join(IMGDIR, 'neg', f)}));
  else if (!IMGDIR) {
    for (const q of ['set:dmu', 'set:mom', 'set:woe']) {
      const r = await get(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}`, false);
      for (const c of (r && r.data) || []) { const u = c.image_uris && c.image_uris.normal; if (u) negUrls.push({url: u, kind: 'mtg'}); }
      await sleep(150);
    }
    for (const s of ['sv03', 'sv04', 'swsh9']) {
      const r = await get(`https://api.tcgdex.net/v2/en/sets/${s}`, false);
      for (const c of ((r && r.cards) || []).slice(0, 60)) if (c.image) negUrls.push({url: c.image + '/high.jpg', kind: 'pkm'});
    }
    negUrls.sort(() => rnd() - 0.5);
  }
  for (const n of negUrls.slice(0, NEG)) {
    const buf = n.file ? fs.readFileSync(n.file) : await get(n.url, true);
    if (!buf) continue;
    try {
      const sim = await simulate(buf);
      const {m} = runPipeline(sim, true);
      negs.push({d: m ? m.dist : 99, margin: m ? m.margin : 0, kind: n.kind});
    } catch (e) {}
    if (!n.file) await sleep(80);
  }
  // --- Auswertung ---
  for (const mode of ['ref', 'raw']) {
    const P = pos[mode];
    const okD = P.filter(p => p.ok).map(p => p.d);
    console.log(`\n== ${mode === 'ref' ? 'MIT Kantenverfeinerung' : 'OHNE Kantenverfeinerung'}: ${P.length} Proben, Top-1 richtig: ${(100 * okD.length / P.length).toFixed(1)} %` +
      (mode === 'ref' ? `, Kanten gefunden (beide Achsen): ${(100 * P.filter(p => p.refined === 2).length / P.length).toFixed(0)} %` : ''));
    console.log('   Abstand richtige Treffer: p50', pct(okD, .5), 'p90', pct(okD, .9), 'p98', pct(okD, .98));
    console.log('   Abstand falsche Top-1:   ', P.filter(p => !p.ok).map(p => p.d).sort((a, b) => a - b).join(' '));
  }
  const nd = negs.map(n => n.d);
  console.log(`\n== Gegenproben: ${negs.length}, kleinster Abstand p2 ${pct(nd, .02)} p10 ${pct(nd, .1)} p50 ${pct(nd, .5)}; min ${Math.min(...nd)}`);
  console.log('\nSchwellen-Tabelle (MIT Verfeinerung): maxDist/minMargin → richtig angenommen % | falsch angenommen % | Gegenproben angenommen %');
  const P = pos.ref;
  let bestRow = null;
  for (const md of [16, 18, 20, 22, 24, 26, 28, 30, 32, 34]) for (const mm of [0, 3, 5, 7, 9]) {
    const acc = P.filter(p => p.ok && p.d <= md && p.margin >= mm).length / P.length;
    const wrong = P.filter(p => !p.ok && p.d <= md && p.margin >= mm).length / P.length;
    const negA = negs.filter(n => n.d <= md && n.margin >= mm).length / Math.max(1, negs.length);
    console.log(`   ${md}/${mm}: ${(100 * acc).toFixed(1)} | ${(100 * wrong).toFixed(1)} | ${(100 * negA).toFixed(1)}`);
    if (wrong <= 0.005 && negA <= 0.01 && (!bestRow || acc > bestRow.acc)) bestRow = {md, mm, acc, wrong, negA};
  }
  console.log('\nEmpfehlung:', JSON.stringify(bestRow));
})().catch(e => { console.error(e); process.exit(1); });
