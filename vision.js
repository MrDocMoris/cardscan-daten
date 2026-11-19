/*
 * CardScan – Bilderkennung
 * Gleicher Code läuft in der App (Browser/WebView) und auf GitHub (Node) beim Bau der Fingerabdruck-Datenbank,
 * damit beide Seiten exakt gleich rechnen.
 *
 * Ablauf: Graustufen → Integralbild → Kartenränder verfeinern → Artwork-Ausschnitt →
 *         128-Bit-Fingerabdruck (64 Bit pHash + 64 Bit dHash) → Hamming-Abstand zur Datenbank.
 */
(function (root) {
  'use strict';

  // Artwork-Bereich als Anteil der Karte (leicht nach innen versetzt, damit kein Rahmen mit drin ist)
  const ART = {
    ygo: {x0: 0.15, y0: 0.21, x1: 0.85, y1: 0.675}
  };
  const ASPECT = {ygo: 59 / 86, mtg: 63 / 88, pkm: 63 / 88};
  // Annahme-Schwellen (werden anhand der Validierung auf GitHub eingestellt)
  const ACCEPT = {ygo: {maxDist: 26, minMargin: 7}}; // kalibriert: 98 % angenommen, 0 Verwechslungen, 0 Fehlalarme (data/validierung.txt)

  const N = 32;
  const COS = (() => {
    const t = new Float64Array(8 * N);
    for (let u = 0; u < 8; u++) for (let x = 0; x < N; x++) t[u * N + x] = Math.cos((2 * x + 1) * u * Math.PI / (2 * N));
    return t;
  })();

  /* ---------- Grundlagen ---------- */
  function gray(data, w, h, channels) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += channels) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    return {g, w, h};
  }
  function integral(G) {
    const {g, w, h} = G, W = w + 1;
    const I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += g[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; }
    }
    return {I, w, h};
  }
  function boxMean(S, x0, y0, x1, y1) {
    const W = S.w + 1;
    x0 = Math.max(0, Math.min(S.w - 1, Math.round(x0))); y0 = Math.max(0, Math.min(S.h - 1, Math.round(y0)));
    x1 = Math.max(x0 + 1, Math.min(S.w, Math.round(x1))); y1 = Math.max(y0 + 1, Math.min(S.h, Math.round(y1)));
    const I = S.I;
    return (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
  }
  function grid(S, r, gw, gh) {
    const out = new Float64Array(gw * gh), cw = r.w / gw, ch = r.h / gh;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++)
      out[j * gw + i] = boxMean(S, r.x + i * cw, r.y + j * ch, r.x + (i + 1) * cw, r.y + (j + 1) * ch);
    return out;
  }

  /* ---------- Fingerabdruck ---------- */
  function hashRect(S, r) {
    const out = new Uint32Array(4);
    // pHash: 32×32 → DCT → 8×8 tiefe Frequenzen gegen Median
    const p = grid(S, r, N, N);
    const tmp = new Float64Array(8 * N);
    for (let u = 0; u < 8; u++) for (let y = 0; y < N; y++) {
      let s = 0; for (let x = 0; x < N; x++) s += p[y * N + x] * COS[u * N + x];
      tmp[u * N + y] = s;
    }
    const c = new Float64Array(64);
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
      let s = 0; for (let y = 0; y < N; y++) s += tmp[u * N + y] * COS[v * N + y];
      c[v * 8 + u] = s;
    }
    const sorted = Array.from(c.subarray(1)).sort((a, b) => a - b), med = sorted[31];
    for (let k = 0; k < 64; k++) if (c[k] > med) out[k >> 5] |= (1 << (k & 31));
    // dHash: 9×8 Nachbarvergleich
    const d = grid(S, r, 9, 8);
    let k = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++, k++) if (d[y * 9 + x] > d[y * 9 + x + 1]) out[2 + (k >> 5)] |= (1 << (k & 31));
    return out;
  }
  function artRect(card, game) {
    const a = ART[game];
    return {x: card.x + a.x0 * card.w, y: card.y + a.y0 * card.h, w: (a.x1 - a.x0) * card.w, h: (a.y1 - a.y0) * card.h};
  }
  /* Fingerabdruck einer (exakt bekannten) Karte – für die Datenbank */
  function cardHash(S, card, game) { return hashRect(S, artRect(card, game)); }
  /* Mehrere leicht verschobene/skalierte Varianten – fürs Kamerabild, weil die Ränder nie ganz exakt sind */
  function jitterHashes(S, card, game, amount) {
    const a = artRect(card, game), out = [];
    const d = amount == null ? 0.025 : amount;
    for (const s of [1, 0.965, 1.035]) for (const dy of [0, -d, d]) for (const dx of [0, -d, d]) {
      if (s !== 1 && (dx || dy)) continue;
      const w = a.w * s, h = a.h * s;
      out.push(hashRect(S, {x: a.x + (a.w - w) / 2 + dx * card.w, y: a.y + (a.h - h) / 2 + dy * card.h, w, h}));
    }
    return out;
  }

  /* ---------- Abgleich ---------- */
  function pc(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; }
  function dist(a, ai, b, bi) { return pc(a[ai] ^ b[bi]) + pc(a[ai + 1] ^ b[bi + 1]) + pc(a[ai + 2] ^ b[bi + 2]) + pc(a[ai + 3] ^ b[bi + 3]); }
  /* db: {count, cardIds:Uint32Array, imageIds:Uint32Array, hashes:Uint32Array(4*count)} */
  function match(db, hashes) {
    const best = new Map(); // cardId → kleinster Abstand
    let top = {d: 999, i: -1};
    for (let i = 0; i < db.count; i++) {
      let m = 999;
      for (const h of hashes) { const dd = dist(h, 0, db.hashes, i * 4); if (dd < m) m = dd; }
      const cid = db.cardIds[i];
      const prev = best.get(cid);
      if (prev === undefined || m < prev.d) best.set(cid, {d: m, i});
      if (m < top.d) top = {d: m, i};
    }
    if (top.i < 0) return null;
    const topCard = db.cardIds[top.i];
    let second = 999;
    for (const [cid, v] of best) if (cid !== topCard && v.d < second) second = v.d;
    return {cardId: topCard, imageId: db.imageIds[top.i], dist: top.d, second, margin: second - top.d};
  }
  function accepted(m, game) {
    const t = ACCEPT[game];
    return !!m && m.dist <= t.maxDist && m.margin >= t.minMargin;
  }

  /* ---------- Datenbank-Datei (ygo.bin) ---------- */
  // Kopf: "CSH1" + Anzahl (uint32), dann je Eintrag: cardId, imageId, 4×Hash (alles uint32 little endian)
  function encodeDB(entries) {
    const buf = new ArrayBuffer(8 + entries.length * 24), dv = new DataView(buf);
    [67, 83, 72, 49].forEach((c, i) => dv.setUint8(i, c));
    dv.setUint32(4, entries.length, true);
    entries.forEach((e, n) => {
      const o = 8 + n * 24;
      dv.setUint32(o, e.cardId, true); dv.setUint32(o + 4, e.imageId, true);
      for (let k = 0; k < 4; k++) dv.setUint32(o + 8 + k * 4, e.hash[k] >>> 0, true);
    });
    return buf;
  }
  function decodeDB(buf) {
    const dv = new DataView(buf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'CSH1') throw new Error('Falsches Dateiformat');
    const count = dv.getUint32(4, true);
    const cardIds = new Uint32Array(count), imageIds = new Uint32Array(count), hashes = new Uint32Array(count * 4);
    for (let n = 0; n < count; n++) {
      const o = 8 + n * 24;
      cardIds[n] = dv.getUint32(o, true); imageIds[n] = dv.getUint32(o + 4, true);
      for (let k = 0; k < 4; k++) hashes[n * 4 + k] = dv.getUint32(o + 8 + k * 4, true);
    }
    return {count, cardIds, imageIds, hashes};
  }

  /* ---------- Kartenränder im Kamerabild finden ---------- */
  // G: Graustufenbild, guess: ungefähre Kartenposition (Rahmen), aspect: erwartetes Seitenverhältnis
  function refineRect(G, guess, aspect) {
    const {g, w, h} = G;
    const bx = guess.w * 0.14, by = guess.h * 0.10;
    const clampX = v => Math.max(1, Math.min(w - 2, Math.round(v)));
    const clampY = v => Math.max(1, Math.min(h - 2, Math.round(v)));
    const y0 = clampY(guess.y + guess.h * 0.2), y1 = clampY(guess.y + guess.h * 0.8);
    const x0 = clampX(guess.x + guess.w * 0.2), x1 = clampX(guess.x + guess.w * 0.8);
    const stepY = Math.max(1, Math.floor((y1 - y0) / 160)), stepX = Math.max(1, Math.floor((x1 - x0) / 120));
    const colScore = x => { let s = 0; for (let y = y0; y < y1; y += stepY) s += Math.abs(g[y * w + x + 1] - g[y * w + x - 1]); return s; };
    const rowScore = y => { let s = 0; for (let x = x0; x < x1; x += stepX) s += Math.abs(g[(y + 1) * w + x] - g[(y - 1) * w + x]); return s; };
    // Kandidaten-Kanten (lokale Maxima) je Seite
    const peaks = (from, to, fn) => {
      from = Math.round(from); to = Math.round(to);
      const sc = []; for (let v = from; v <= to; v++) sc.push(fn(v));
      const sm = sc.map((s, i) => (sc[i - 1] || s) * 0.25 + s * 0.5 + (sc[i + 1] || s) * 0.25);
      const mx = Math.max(...sm); if (!(mx > 0)) return [];
      const mean = sm.reduce((a, b) => a + b, 0) / sm.length;
      if (mx < mean * 1.6) return [];
      const out = [];
      for (let i = 0; i < sm.length; i++) if (sm[i] >= mx * 0.35 && sm[i] >= (sm[i - 1] || 0) && sm[i] >= (sm[i + 1] || 0)) out.push({v: from + i, s: sm[i] / mx});
      return out.sort((p, q) => q.s - p.s).slice(0, 4);
    };
    const PL = peaks(clampX(guess.x - bx), clampX(guess.x + bx), colScore);
    const PR = peaks(clampX(guess.x + guess.w - bx), clampX(guess.x + guess.w + bx), colScore);
    const PT = peaks(clampY(guess.y - by), clampY(guess.y + by), rowScore);
    const PB = peaks(clampY(guess.y + guess.h - by), clampY(guess.y + guess.h + by), rowScore);
    const dflt = (arr, v) => arr.length ? arr : [{v, s: 0, d: 1}];
    let best = null;
    for (const l of dflt(PL, guess.x)) for (const rr of dflt(PR, guess.x + guess.w)) {
      const cw = rr.v - l.v; if (cw < guess.w * 0.75) continue;
      for (const t of dflt(PT, guess.y)) for (const bb of dflt(PB, guess.y + guess.h)) {
        const chh = bb.v - t.v; if (chh < guess.h * 0.75) continue;
        const arErr = aspect ? Math.abs(cw / chh - aspect) / aspect : 0;
        const off = (Math.abs(l.v - guess.x) + Math.abs(rr.v - guess.x - guess.w)) / guess.w + (Math.abs(t.v - guess.y) + Math.abs(bb.v - guess.y - guess.h)) / guess.h;
        const score = (l.s + rr.s + t.s + bb.s) / 4 - 5 * arErr - 0.8 * off / 4;
        if (!best || score > best.score) best = {score, l, rr, t, bb, arErr};
      }
    }
    let r = {x: guess.x, y: guess.y, w: guess.w, h: guess.h, refined: 0};
    if (best && best.arErr < 0.08) {
      if (PL.length && PR.length) { r.x = best.l.v; r.w = best.rr.v - best.l.v; r.refined++; }
      if (PT.length && PB.length) { r.y = best.t.v; r.h = best.bb.v - best.t.v; r.refined++; }
      // nur eine Achse sicher → andere über das Seitenverhältnis ableiten
      if (r.refined === 1 && aspect) {
        if (PL.length && PR.length) { const h2 = r.w / aspect; r.y = guess.y + (guess.h - h2) / 2; r.h = h2; }
        else { const w2 = r.h * aspect; r.x = guess.x + (guess.w - w2) / 2; r.w = w2; }
      }
    }
    return r;
  }

  /* Fingerabdrücke fürs Kamerabild: verfeinerte Kanten UND der Rahmen selbst (jeweils mit Varianten) */
  function frameHashes(G, S, guess, game) {
    const r = refineRect(G, guess, ASPECT[game]);
    const hs = jitterHashes(S, guess, game);
    if (r.refined) hs.push(...jitterHashes(S, r, game));
    return {hashes: hs, rect: r.refined ? r : guess};
  }

  const Vision = {frameHashes, ART, ASPECT, ACCEPT, gray, integral, hashRect, artRect, cardHash, jitterHashes, match, accepted, dist, encodeDB, decodeDB, refineRect, popcount: pc};
  if (typeof module !== 'undefined' && module.exports) module.exports = Vision;
  else root.Vision = Vision;
})(typeof self !== 'undefined' ? self : this);
