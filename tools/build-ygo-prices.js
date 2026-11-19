// Ordnet jedem Yu-Gi-Oh-Druck (Set-Code + Seltenheit) seinen Cardmarket-Preis zu → data/ygo-prices.json
// Quellen: Cardmarket Produktkatalog + Preisliste (öffentliche Downloads), YGOPRODeck (Set-Codes, Seltenheiten)
// Aufruf: node tools/build-ygo-prices.js [--raw DIR]   (DIR mit bereits geladenen JSON-Dateien, sonst Download)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const RAW = (() => { const i = process.argv.indexOf('--raw'); return i > 0 ? process.argv[i + 1] : null; })();
const URLS = {
  products: 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_3.json',
  prices: 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_3.json',
  cards: 'https://db.ygoprodeck.com/api/v7/cardinfo.php'
};
const FILES = {products: 'cm_products_3.json', prices: 'cm_prices_3.json', cards: 'ygo_cardinfo.json'};
async function load(k) {
  if (RAW) return JSON.parse(fs.readFileSync(path.join(RAW, FILES[k]), 'utf8'));
  for (let t = 1; t <= 4; t++) {
    try { const r = await fetch(URLS[k], {headers: {'User-Agent': 'CardScan-Prices/1.0'}}); if (!r.ok) throw new Error(r.status); return await r.json(); }
    catch (e) { if (t === 4) throw e; await new Promise(r => setTimeout(r, 2000 * t)); }
  }
}
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// Rangfolge der Seltenheiten (für die Zuordnung nach Preis)
const RANK = [
  ['common', 0], ['short print', 0.3], ['super short print', 0.4], ['normal parallel', 1], ['rare', 2], ['super parallel', 3.2],
  ['super rare', 3], ['ultra parallel', 4.2], ['ultra rare', 4], ['gold rare', 4.3], ['premium gold', 4.4], ['gold secret', 5.6],
  ['ultimate rare', 5], ['secret rare', 5.5], ['prismatic secret', 6], ['platinum secret', 6.2], ['extra secret', 6.3], ['10000 secret', 9],
  ['collector', 6.5], ['ghost rare', 7], ['starlight', 8], ['quarter century', 8.5], ['mosaic', 3.5], ['starfoil', 3.4], ['shatterfoil', 3.6]
];
function rank(r) {
  const s = String(r).toLowerCase(); let best = 2, len = 0;
  for (const [k, v] of RANK) if (s.includes(k) && k.length > len) { best = v; len = k.length; }
  return best;
}

(async () => {
  const [P, G, Y] = [await load('products'), await load('prices'), await load('cards')];
  const price = new Map(G.priceGuides.map(g => [g.idProduct, g]));
  const val = g => g ? (g.avg30 ?? g.trend ?? g.avg ?? g.low ?? 0) : 0;

  // Cardmarket: Expansion → Produkte, Kartenname → Produkte
  const exp = new Map();
  for (const p of P.products) {
    if (!exp.has(p.idExpansion)) exp.set(p.idExpansion, {id: p.idExpansion, names: new Set(), byName: new Map(), date: p.dateAdded});
    const e = exp.get(p.idExpansion), n = norm(p.name);
    e.names.add(n); if (!e.byName.has(n)) e.byName.set(n, []); e.byName.get(n).push(p.idProduct);
    if (p.dateAdded < e.date) e.date = p.dateAdded;
  }
  const inv = new Map();
  for (const e of exp.values()) for (const n of e.names) { if (!inv.has(n)) inv.set(n, []); inv.get(n).push(e.id); }

  // YGOPRODeck: Setname → Kartenname → Drucke
  const ysets = new Map();
  for (const c of Y.data) for (const s of (c.card_sets || [])) {
    if (!ysets.has(s.set_name)) ysets.set(s.set_name, new Map());
    const m = ysets.get(s.set_name), n = norm(c.name);
    if (!m.has(n)) m.set(n, []);
    m.get(n).push({code: s.set_code, rarity: s.set_rarity});
  }

  // 1) Sets zuordnen (Überschneidung der Kartennamen; bei Gleichstand das ältere Original)
  const setMap = new Map();
  for (const [sn, cards] of ysets) {
    const A = new Set(cards.keys()), cnt = new Map();
    for (const n of A) for (const e of (inv.get(n) || [])) cnt.set(e, (cnt.get(e) || 0) + 1);
    const cands = [];
    for (const [eid, v] of cnt) { const e = exp.get(eid); cands.push({eid, v, score: v / (A.size + e.names.size - v)}); }
    const top = Math.max(0, ...cands.map(c => c.score));
    let best = null;
    for (const c of cands.filter(c => c.score >= top * 0.85)) {
      // Passung: bei wie vielen Karten stimmt die Zahl der Produkte mit der Zahl der Seltenheiten überein?
      const e = exp.get(c.eid); let fit = 0;
      for (const [n, prints] of cards) { const pr = e.byName.get(n); if (pr && pr.length === prints.length) fit++; }
      c.fit = fit;
      if (!best || fit > best.fit || (fit === best.fit && (c.score > best.score + 1e-9 || (Math.abs(c.score - best.score) < 1e-9 && e.date < exp.get(best.eid).date)))) best = c;
    }
    if (best && best.score >= 0.5 && best.v >= Math.min(3, A.size)) setMap.set(sn, best.eid);
  }

  // 2) Innerhalb eines Sets: Drucke (nach Seltenheit) ↔ Produkte (nach Preis)
  const out = {}; const used = new Set();
  let mapped = 0, approx = 0, total = 0, ranged = 0;
  const assign = (prints, prods, approxFlag) => {
    // Drucke gleicher Seltenheit (z.B. LOB-001 / LOB-E001 / LOB-EN001) zu einer Gruppe zusammenfassen
    const groups = new Map();
    for (const p of prints) { if (!groups.has(p.rarity)) groups.set(p.rarity, []); groups.get(p.rarity).push(p); }
    const gs = [...groups.values()].sort((a, b) => rank(a[0].rarity) - rank(b[0].rarity));
    const pr = [...prods].sort((a, b) => val(price.get(a)) - val(price.get(b)));
    if (prints.length === pr.length) { // gleich viele Drucke wie Produkte: direkt nach Rang/Preis
      const ps = [...prints].sort((a, b) => rank(a.rarity) - rank(b.rarity));
      ps.forEach((p, i) => put(p, pr[i], approxFlag || groups.get(p.rarity).length > 1));
    }
    else if (gs.length === pr.length) gs.forEach((g, i) => g.forEach(p => put(p, pr[i], approxFlag || g.length > 1)));
    else if (pr.length === 1) prints.forEach(p => put(p, pr[0], true));
    else { // nicht eindeutig (z.B. mehrere Auflagen): Preisspanne der passenden Produkte
      const ts = pr.map(id => price.get(id)).filter(Boolean).map(g => g.trend ?? g.avg30).filter(v => v != null);
      if (!ts.length) return false;
      prints.forEach(p => { out[`${p.code}|${p.rarity}`] = [Math.min(...ts), Math.max(...ts), null, null, 2]; ranged++; });
    }
    pr.forEach(id => used.add(id));
    return true;
  };
  const put = (p, id, ap) => {
    const g = price.get(id) || {};
    out[`${p.code}|${p.rarity}`] = [g.trend ?? null, g.avg30 ?? null, g.low ?? null, id, ap ? 1 : 0];
    mapped++; if (ap) approx++;
  };
  const leftovers = new Map(); // Kartenname → nicht zugeordnete Drucke
  for (const [sn, cards] of ysets) for (const [n, prints] of cards) {
    total += prints.length;
    const eid = setMap.get(sn);
    const prods = eid != null ? exp.get(eid).byName.get(n) : null;
    if (!prods || !assign(prints, prods, false)) {
      if (!leftovers.has(n)) leftovers.set(n, []);
      leftovers.get(n).push(...prints);
    }
  }
  // 3) Übrige Drucke: eindeutige Einzelzuordnung (z.B. Promos)
  const prodsByName = new Map();
  for (const p of P.products) { const n = norm(p.name); if (!prodsByName.has(n)) prodsByName.set(n, []); prodsByName.get(n).push(p.idProduct); }
  for (const [n, prints] of leftovers) {
    const free = (prodsByName.get(n) || []).filter(id => !used.has(id));
    if (prints.length === 1 && free.length === 1) { put(prints[0], free[0], true); used.add(free[0]); }
  }
  fs.mkdirSync(path.join(ROOT, 'data'), {recursive: true});
  fs.writeFileSync(path.join(ROOT, 'data', 'ygo-prices.json'), JSON.stringify({date: G.createdAt, p: out}));
  console.log(`Sets zugeordnet: ${setMap.size}/${ysets.size}; Drucke mit Preis: ${mapped}/${total} (${(100 * mapped / total).toFixed(1)} %), davon ungefähr: ${approx}; zusätzlich als Preisspanne: ${ranged} → zusammen ${(100 * (mapped + ranged) / total).toFixed(1)} %`);

  console.log('Größe:', (fs.statSync(path.join(ROOT, 'data', 'ygo-prices.json')).size / 1024).toFixed(0), 'KB');
  const show = k => console.log(' ', k, JSON.stringify(out[k] || null));
  ['EEN-EN023|Rare', 'EEN-EN023|Ultimate Rare', 'DR04-EN083|Ultra Rare', 'RA03-EN158|Platinum Secret Rare', 'RA03-EN158|Quarter Century Secret Rare',
   'LOB-001|Ultra Rare', 'LOB-EN001|Ultra Rare', 'SDK-001|Ultra Rare', 'LCJW-EN245|Secret Rare'].forEach(show);
})().catch(e => { console.error(e); process.exit(1); });
