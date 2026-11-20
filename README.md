# Antizyklisches Einstiegssignal

Dashboard der RichtigAnlegen AG.

## Seiten

| Datei | Zweck |
|---|---|
| `index.html` | Dashboard ohne Passwort, eingebettet im Kurs |
| `index_password.html` | Gleiches Dashboard mit Passwort, für Beratungskundschaft |
| `kunden.html` | Kopie von `index_password.html` (bestehende Links bleiben gültig) |

`index_password.html` und `kunden.html` werden aus `index.html` erzeugt:
`python3 scripts/build_password.py`. Änderungen daher nur in `index.html` vornehmen.

## Daten

Live-Werte und Monatshistorie liefert der Cloudflare Worker
`signal-dashboard.blue-hill-33fd.workers.dev` (Quellcode in `worker/worker.js`).

| Indikator | Quelle | Ersatzquelle |
|---|---|---|
| Fear & Greed | CNN | feargreedmeter.com |
| VIX | Yahoo ^VIX | mmeter |
| S&P 500, S&P 500 TR, USD/CHF | Yahoo | Yahoo (zweiter Server) |
| High-Yield Spread | FRED BAMLH0A0HYM2 | |
| Put/Call Ratio | CBOE Tagesstatistik, Total P/C, 10-Tage-Schnitt | |
| SPI | SIX | Yahoo ^SSHI |

Die CBOE-CSV-Dateien `totalpc.csv` und `equitypc.csv` werden seit Oktober 2019 nicht mehr
nachgeführt und dürfen nicht verwendet werden.

Jeder Wert wird auf Plausibilität geprüft. Fällt eine Quelle aus, zeigt das Dashboard einen
Hinweis in der Statuszeile.

## Automatik

Der Worker läuft täglich um 22:30 UTC (Cron) und
- schreibt den Monatswert des laufenden Monats in KV (`m:YYYY-MM`), am Monatsende bleibt so der Schlusswert stehen,
- führt das Allzeithoch von S&P 500, SPI und S&P 500 TR in CHF nach,
- protokolliert den Lauf.

Das Dashboard mischt die statische Historie bis März 2026 (`H_DATA` in `index.html`) mit den
Monatswerten aus `/api/history`. Manuelle Nachträge sind nicht mehr nötig.

Kontrolle: `https://signal-dashboard.blue-hill-33fd.workers.dev/api/health`
(`healthy: true`, wenn alle Quellen liefern und der letzte Cron-Lauf weniger als 30 Stunden zurückliegt).

## Worker aktualisieren

Cloudflare Dashboard > Workers > signal-dashboard > Code bearbeiten, Inhalt von `worker/worker.js`
einfügen und speichern. Bindings: KV `HIST`, Secrets `FRED_KEY` und `ADMIN_KEY`, Cron `30 22 * * *`.
