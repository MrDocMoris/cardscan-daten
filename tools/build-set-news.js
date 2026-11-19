// Erzeugt data/set-news.json: neu erschienene (letzte ~4 Monate) und kommende Sets für Magic, Yu-Gi-Oh und Pokémon.
// Quellen: Scryfall, YGOPRODeck, TCGdex (+ pokemontcg.io als Ersatz), ergänzt um data/set-news-extra.json
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'data', 'set-news.json');
const EXTRA = path.join(__dirname, '..', 'data', 'set-news-extra.json');
const DAY = 864e5, today = new Date(new Date().toISOString().slice(0, 10)).getTime();
const FROM = today - 125 * DAY, TO = today + 400 * DAY;
const inWin = d => { const t = Date.parse(d); return t >= FROM && t <= TO; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 3){
  for(let i = 0; i < tries; i++){
    try{ const r = await fetch(url, {headers:{'User-Agent':'TCG-Multiversum/1.0', Accept:'application/json'}}); if(r.ok) return await r.json(); console.log('HTTP', r.status, url); }
    catch(e){ console.log('Fehler', url, e.message); }
    await sleep(1500 * (i + 1));
  }
  return null;
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function mtg(){
  const j = await get('https://api.scryfall.com/sets'); if(!j) return [];
  const TYPES = {expansion:'Erweiterung', core:'Grundset', masters:'Masters', draft_innovation:'Draft-Set', commander:'Commander', funny:'Fun-Set', starter:'Einsteiger'};
  return j.data.filter(s => TYPES[s.set_type] && !s.digital && inWin(s.released_at) && !(s.parent_set_code && s.set_type !== 'commander'))
    .map(s => ({game:'mtg', name:s.name, code:s.code.toUpperCase(), date:s.released_at, type:TYPES[s.set_type], cards:s.card_count || null, logo:s.icon_svg_uri || null}));
}
async function ygo(){
  const j = await get('https://db.ygoprodeck.com/api/v7/cardsets.php'); if(!Array.isArray(j)) return [];
  const SKIP = /promo|prize|participation|tournament pack|championship|sneak peek|special edition|demo|duelist league|judge|sample|starter deck 20|mega-?pack|gold series 2|tin of/i;
  const typeOf = n => /structure deck/i.test(n) ? 'Structure Deck' : /tin/i.test(n) ? 'Tin' : /starter/i.test(n) ? 'Starter Deck' : /battles of legend|rarity collection|legendary|duelist pack|collection|maximum gold|dragons of legend|ghosts from the past/i.test(n) ? 'Special Set' : 'Booster Set';
  const seen = new Set();
  return j.filter(s => s.tcg_date && inWin(s.tcg_date) && !SKIP.test(s.set_name) && ((s.num_of_cards || 0) >= 10 || Date.parse(s.tcg_date) > today))
    .filter(s => { const k = norm(s.set_name); if(seen.has(k)) return false; seen.add(k); return true; })
    .map(s => ({game:'ygo', name:s.set_name, code:s.set_code, date:s.tcg_date, type:typeOf(s.set_name), cards:s.num_of_cards || null, logo:s.set_image || `https://images.ygoprodeck.com/images/sets/${encodeURIComponent(s.set_code)}.jpg`}));
}
async function pkm(){
  const out = [];
  const list = await get('https://api.tcgdex.net/v2/de/sets');
  if(Array.isArray(list)){
    // die Liste ist chronologisch – die neuesten stehen am Ende; Pocket-Sets (TCG Pocket) auslassen
    const cand = list.filter(s => !/^(A\d|P-A|B\d)/i.test(s.id)).slice(-30);
    for(const s of cand){
      const d = await get(`https://api.tcgdex.net/v2/de/sets/${encodeURIComponent(s.id)}`); await sleep(120);
      if(!d || !d.releaseDate || !inWin(d.releaseDate)) continue;
      const en = await get(`https://api.tcgdex.net/v2/en/sets/${encodeURIComponent(s.id)}`); await sleep(120);
      out.push({game:'pkm', name:d.name, nameEn:en && en.name !== d.name ? en.name : null, code:(d.abbreviation && d.abbreviation.official) || d.id.toUpperCase(), date:d.releaseDate,
        type:d.serie && d.serie.name ? d.serie.name : 'Erweiterung', cards:(d.cardCount && (d.cardCount.official || d.cardCount.total)) || null, logo:d.logo ? d.logo + '.png' : null});
    }
  }
  // Ersatz/Ergänzung: pokemontcg.io (englische Namen)
  const p = await get('https://api.pokemontcg.io/v2/sets?orderBy=-releaseDate&pageSize=20');
  if(p && p.data) for(const s of p.data){
    const date = s.releaseDate.replace(/\//g, '-'); if(!inWin(date)) continue;
    if(out.some(x => Math.abs(Date.parse(x.date) - Date.parse(date)) < 10 * DAY && (norm(x.nameEn || x.name) === norm(s.name) || norm(x.name) === norm(s.name)))) continue;
    if(out.some(x => x.code && s.ptcgoCode && x.code.toUpperCase() === s.ptcgoCode.toUpperCase())) continue;
    out.push({game:'pkm', name:s.name, code:s.ptcgoCode || s.id.toUpperCase(), date, type:s.series || 'Erweiterung', cards:s.printedTotal || null, logo:s.images && s.images.logo || null});
  }
  return out;
}
(async () => {
  const [a, b, c] = await Promise.all([mtg(), ygo(), pkm()]);
  console.log(`API: Magic ${a.length}, Yu-Gi-Oh ${b.length}, Pokémon ${c.length}`);
  let sets = [...a, ...b, ...c];
  // angekündigte Sets ergänzen, falls die API sie (noch) nicht kennt
  let extra = [];
  try{ extra = JSON.parse(fs.readFileSync(EXTRA, 'utf8')).sets || []; }catch(e){}
  for(const e of extra){
    if(!inWin(e.date)) continue;
    const ne = norm(e.name).replace(/\b(universes beyond|noch unbenannt|mega entwicklung|mega lucario z)\b/g, '').trim();
    const known = sets.some(s => s.game === e.game && (
      (ne && (norm(s.name).includes(ne) || ne.includes(norm(s.name)) || norm(s.nameEn).includes(ne))) ||
      (Math.abs(Date.parse(s.date) - Date.parse(e.date)) < 3 * DAY && /unbenannt/.test(e.name))));
    if(!known) sets.push(Object.assign({source:'angekündigt'}, e));
  }
  // Sets gleichen Spiels am selben Tag mit sehr ähnlichem Namen zusammenfassen
  sets.sort((x, y) => y.date.localeCompare(x.date) || x.game.localeCompare(y.game) || x.name.localeCompare(y.name));
  const prev = (() => { try{ return JSON.parse(fs.readFileSync(OUT, 'utf8')); }catch(e){ return null; } })();
  // Bei Ausfall einer Quelle die alten Einträge dieses Spiels behalten
  if(prev && prev.sets) for(const [g, arr] of [['mtg', a], ['ygo', b], ['pkm', c]]) if(!arr.length){
    console.log('Quelle ausgefallen, behalte alte Daten:', g);
    sets = sets.filter(s => s.game !== g || s.source).concat(prev.sets.filter(s => s.game === g && !s.source && inWin(s.date)));
  }
  sets.sort((x, y) => y.date.localeCompare(x.date));
  const json = {date:new Date().toISOString(), sets};
  fs.writeFileSync(OUT, JSON.stringify(json));
  for(const s of sets.filter(s => Date.parse(s.date) >= today - 30 * DAY).slice(-40)) console.log(s.date, s.game, s.name, s.code || '', s.source || '');
  console.log('Gesamt', sets.length);
})();
