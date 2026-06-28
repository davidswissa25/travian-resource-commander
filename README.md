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
- **Balance analysis** (Trade Routes tab) — per village, each resource's net/h **with your active routes applied**, classified as draining ("empty in 3h"), nearing overflow ("full in 5h") or stable, sorted by soonest problem.
- **JSON import/export** for backup and as the bridge to automation.

## Files

- `travian-tool.html` — the application. Double-click to open.
- `travian-commander-sync.user.js` — optional read-only Tampermonkey userscript. Adds a one-click **⤓ Pull & Sync** button on the game that pushes every village's data straight into `travian-tool.html` (open in another tab) — no console, no file import. Captures production, current warehouse/granary stock + capacity, merchant capacity, **and your active recurring trade routes** (from each marketplace's Trade routes tab).

## Usage

1. Open `travian-tool.html`.
2. Get your village data in, either way:
   - **Paste from game:** in game open **Statistics → Resources → Warehouse**, press **Ctrl+U**, select all, copy, then in the tool **Paste from game** → paste → **Parse & preview** → **Import**.
   - **Pull & Sync (userscript):** install `travian-commander-sync.user.js` in Tampermonkey, enable **Allow access to file URLs** for the extension, open both your game world and `travian-tool.html`, then click the floating **⤓ Pull & Sync** button on the game — the tool updates instantly.
3. Set each village's Trade Office and Marketplace level (and the alliance bonus / server URL) for exact merchant math, then use the **Auto Routes** tab.
4. Check the **Trade Routes** tab: your active in-game routes appear automatically (synced routes are kept in step with the game — deleting one in-game removes it here on the next sync, while routes you add by hand are preserved), and the **Balance analysis** at the top shows which villages are draining or about to overflow once those routes are taken into account.

## Notes / disclaimer

This tool only reads data you paste or view yourself; it performs no automated game actions. Automated scripting can violate Travian's Terms of Service — use at your own discretion.
