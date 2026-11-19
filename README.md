# cardscan-daten

Öffentliche Preisdaten für die CardScan-App (privates Repo `cardscan`).

- `data/ygo-prices.json` – Cardmarket-Preise je Yu-Gi-Oh-Druck (Set-Code + Seltenheit), alle zwei Tage automatisch erzeugt
  aus dem öffentlichen Cardmarket-Produktkatalog/-Preisliste und den Set-Daten von YGOPRODeck.
- `data/ygo.bin` – Bild-Fingerabdrücke aller Yu-Gi-Oh-Kartenbilder (wöchentlich, montags)
- Releases – die CardScan-APK (die App prüft hier auf Updates)
- Enthält keine persönlichen Daten (keine Sammlung, keine Decks).

Format: `{"date": "...", "p": {"SETCODE|Seltenheit": [trend, avg30, low, idProduct, flag]}}`
– flag 0 = eindeutig, 1 = ungefähr, 2 = Preisspanne (dann [min, max, null, null, 2]).
