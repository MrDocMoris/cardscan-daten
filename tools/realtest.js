// Prüft die Bilderkennung mit echten Handyfotos aus testfotos/ (Fotos <spiel>__<Name>.jpg oder Fehlerberichte .json aus der App)
const fs = require('fs'), path = require('path');
const sharp = require('sharp');
const V = require('../vision.js');
const ROOT = path.join(__dirname, '..'), DIR = path.join(ROOT, 'testfotos'), DATA = path.join(ROOT, 'data');
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const DB = {}, NAMES = {};
for(const g of ['ygo', 'mtg', 'pkm']){
  try{ DB[g] = V.decodeDB(new Uint8Array(fs.readFileSync(path.join(DATA, g + '.bin'))).buffer); }catch(e){}
  try{ if(g !== 'ygo') NAMES[g] = JSON.parse(fs.readFileSync(path.join(DATA, g + '-ids.json'), 'utf8')).groups; }catch(e){}
}
const ygoNames = {}; // Yu-Gi-Oh: Namen über die API holen (nur für Treffer)
async function ygoName(id){ if(ygoNames[id]) return ygoNames[id]; try{ const r = await fetch(`https://db.ygoprodeck.com/api/v7/cardinfo.php?id=${id}`); const j = await r.json(); return ygoNames[id] = j.data[0].name; }catch(e){ return String(id); } }
function guesses(w, h){ // Karte ungefähr mittig, verschiedene Größen
  const out = []; const A = 63 / 88;
  for(const f of [0.95, 0.85, 0.75, 0.65, 0.55]){ let gh = h * f, gw = gh * A; if(gw > w * 0.98){ gw = w * 0.98; gh = gw / A; } out.push({x:(w - gw) / 2, y:(h - gh) / 2, w:gw, h:gh}); }
  return out;
}
(async () => {
  if(!fs.existsSync(DIR)){ console.log('Kein Ordner testfotos/'); return; }
  const cases = [];
  for(const f of fs.readdirSync(DIR)){
    const p = path.join(DIR, f);
    if(/\.(jpe?g|png|webp)$/i.test(f)){ const m = f.replace(/\.\w+$/, '').match(/^(mtg|ygo|pkm)__(.+)$/); cases.push({file:f, buf:fs.readFileSync(p), game:m ? m[1] : null, expected:m ? m[2] : f}); }
    else if(/\.json$/i.test(f)){ try{ const r = JSON.parse(fs.readFileSync(p, 'utf8')); if(r.image){ cases.push({file:f, buf:Buffer.from(r.image.split(',')[1], 'base64'), game:(r.game && r.game !== 'auto') ? r.game : null, expected:r.expected || (r.got && r.got.name) || '?', report:r}); } }catch(e){} }
  }
  console.log(`${cases.length} Testfotos · Datenbanken: ${Object.entries(DB).map(([g, d]) => `${g} ${d.count}`).join(', ')}\n`);
  let ok = 0, acc = 0;
  for(const c of cases){
    const {data, info} = await sharp(c.buf).rotate().resize({width:1200, height:1200, fit:'inside'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
    const G = V.gray(data, info.width, info.height, info.channels), S = V.integral(G);
    const E = V.enhance(data, info.width, info.height, info.channels), G2 = V.gray(E, info.width, info.height, info.channels), S2 = V.integral(G2);
    const res = [];
    for(const g of (c.game ? [c.game] : ['mtg', 'pkm', 'ygo'])){
      if(!DB[g]) continue; let best = null;
      for(const gs of guesses(info.width, info.height)) for(const [gg, ss] of [[G, S], [G2, S2]]){
        const fh = V.frameHashes(gg, ss, gs, g), m = V.match(DB[g], fh.hashes); if(m && (!best || m.dist < best.dist)) best = m;
      }
      if(best){ best.game = g; best.ok = V.accepted(best, g); best.name = g === 'ygo' ? await ygoName(best.cardId) : NAMES[g][best.cardId]; res.push(best); }
    }
    res.sort((a, b) => (a.dist - V.ACCEPT[a.game].maxDist) - (b.dist - V.ACCEPT[b.game].maxDist));
    const top = res[0], right = top && norm(top.name).includes(norm(c.expected).replace(/(ex|gx|vmax|vstar|v)$/, '')) ;
    if(right) ok++; if(right && top.ok) acc++;
    console.log(`${right ? (top.ok ? '✓' : '~') : '✗'} ${c.file}\n   erwartet: ${c.expected}\n   ${res.map(r => `${r.game}: ${r.name} (Abstand ${r.dist}, Grenze ${V.ACCEPT[r.game].maxDist}, Abstand zur nächsten ${r.margin})${r.ok ? ' angenommen' : ''}`).join('\n   ')}`);
  }
  console.log(`\nErgebnis: ${ok}/${cases.length} richtig auf Platz 1, davon ${acc} sicher angenommen (✓ sicher, ~ richtig aber unsicher, ✗ falsch)`);
})().catch(e => { console.error(e); process.exit(1); });
