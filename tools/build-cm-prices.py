#!/usr/bin/env python3
"""Lädt Cardmarkets öffentliche Preisliste (Magic, Pokémon) und schreibt kompakte Teil-Dateien.
Ausgabe: out/cm/<spiel>/<00..63>.json  {"d": Datum, "p": {idProduct: [trend, low, avg7, avg30, trendFoil, lowFoil, avg1]}}"""
import json, os, sys, urllib.request, datetime
GAMES = {"mtg": 1, "pkm": 6}
SHARDS = 64
def r2(v):
    return None if v is None else round(float(v), 2)
out = sys.argv[1] if len(sys.argv) > 1 else "out"
stamp = {}
for g, gid in GAMES.items():
    url = f"https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_{gid}.json"
    data = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "TCG-Multiversum"}), timeout=120))
    d = (data.get("createdAt") or datetime.date.today().isoformat())[:10]
    shards = [dict() for _ in range(SHARDS)]
    foil = "holo" if g == "pkm" else "foil"
    for e in data["priceGuides"]:
        pid = e["idProduct"]
        row = [r2(e.get("trend")), r2(e.get("low")), r2(e.get("avg7")), r2(e.get("avg30")), r2(e.get(f"trend-{foil}")), r2(e.get(f"low-{foil}")), r2(e.get("avg1"))]
        while row and row[-1] is None: row.pop()
        if row: shards[pid % SHARDS][str(pid)] = row
    os.makedirs(f"{out}/cm/{g}", exist_ok=True)
    for i, s in enumerate(shards):
        with open(f"{out}/cm/{g}/{i:02d}.json", "w") as f: json.dump({"d": d, "p": s}, f, separators=(",", ":"))
    stamp[g] = {"d": d, "n": sum(len(s) for s in shards)}
    print(g, stamp[g])
with open(f"{out}/cm/stand.json", "w") as f: json.dump(stamp, f)
