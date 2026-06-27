# Travian Resource Commander

A single-file, browser-based tool to manage crop, troop consumption, storage and trade routes across all your Travian villages — with an automatic crop-balancing route optimizer. Built for **Travian Legends (T4.6 / new interface)**.

No install, no build step, no server: open `travian-tool.html` in any browser. Data is saved in that browser (localStorage).

## Features

- **Dashboard** — every village's lumber/clay/iron/crop with live-projected storage bars and a crop clock. Red alert only when a village starves in under 1 hour and no merchants are inbound; calmer states otherwise.
- **Auto Routes optimizer** — proposes crop shipments from surplus villages to draining ones:
  - Prefers the single nearest donor that can cover a whole deficit (fewest routes, shortest trips), with a Min-route penalty to avoid tiny routes.
  - Whole-hour send intervals (1–24) with hh:mm offsets, staggered per source so each city keeps merchants free.
  - Respects merchant capacity **and** merchant count (= marketplace level), accounting for round-trip time and overlapping waves — flags routes the marketplace can't sustain.
  - Server speed auto-detected from the server name (e.g. `x2`); Trade Office and alliance commerce bonuses factored into capacity.
  - One-click **Send** deep-links into the in-game marketplace, pre-filled.
- **Paste from game** — paste the Warehouse statistics page source (Ctrl+U) and it imports every village's stock, capacity, coordinates and crop balance at once. Merges (keeps your routes and manual edits).
- **JSON import/export** for backup and as the bridge to automation.

## Files

- `travian-tool.html` — the application. Double-click to open.
- `travian-sync.user.js` — optional read-only Tampermonkey userscript that captures village data from your logged-in session (alternative to Paste from game).

## Usage

1. Open `travian-tool.html`.
2. In game, open **Statistics → Resources → Warehouse**, press **Ctrl+U**, select all, copy.
3. In the tool: **Paste from game** → paste → **Parse & preview** → **Import**.
4. Set each village's Trade Office and Marketplace level (and the alliance bonus / server URL) for exact merchant math, then use the **Auto Routes** tab.

## Notes / disclaimer

This tool only reads data you paste or view yourself; it performs no automated game actions. Automated scripting can violate Travian's Terms of Service — use at your own discretion.
