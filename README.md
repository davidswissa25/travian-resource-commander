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
- **Profiles** — keep a separate profile per account (your own plus any you sit). Pull & Sync auto-routes each account into its own profile (creating it on first sync); switch profiles from the header dropdown. Import creates a new profile when none matches; Export lets you pick which profile to save.
- **JSON import/export** for backup and as the bridge to automation.

## Files

- `travian-tool.html` — the application. Double-click to open.
- `travian-commander-sync.user.js` — optional Tampermonkey userscript. Adds a one-click **⤓ Pull & Sync** button on the game that pushes every village's data straight into `travian-tool.html` (open in another tab) — no console, no file import. Captures production, current warehouse/granary stock + capacity, merchant capacity, **and your active recurring trade routes** (from each marketplace's Trade routes tab). Pulling is read-only. It also powers the optional **Apply in game** flow (below): a game-side **⚡ Apply routes** panel that pre-fills the in-game *Create trade route* form for each suggested route — you review and press **Create** yourself; it never submits for you.

## Usage

1. Open `travian-tool.html`.
2. Get your village data in, either way:
   - **Paste from game:** in game open **Statistics → Resources → Warehouse**, press **Ctrl+U**, select all, copy, then in the tool **Paste from game** → paste → **Parse & preview** → **Import**.
   - **Pull & Sync (userscript):** install `travian-commander-sync.user.js` in Tampermonkey, enable **Allow access to file URLs** for the extension, open both your game world and `travian-tool.html`, then click the floating **⤓ Pull & Sync** button on the game — the tool updates instantly.
3. Set each village's Trade Office and Marketplace level (and the alliance bonus / server URL) for exact merchant math, then use the **Auto Routes** tab.
4. Check the **Trade Routes** tab: your active in-game routes appear automatically (synced routes are kept in step with the game — deleting one in-game removes it here on the next sync, while routes you add by hand are preserved), and the **Balance analysis** at the top shows which villages are draining or about to overflow once those routes are taken into account.

## Applying routes in-game (semi-automatic)

The **Auto Routes** tab has an **Apply in game ▸** button. It hands the proposed routes to your game tab, where a floating **⚡ Apply routes** panel lists them, grouped and sorted by source village. The panel can be dragged anywhere, and a **fill delay** range paces the form-filling so you can watch it happen.

Two ways to work through the list:

- **Pre-fill ▸** (per route) — jumps to the source village's marketplace, opens *Create trade route*, fills in destination, resources, interval and a whole-hour send time, then highlights **Create trade route** for you to check and click. Nothing is created until you click.
- **▶ Create all N remaining** — works down the whole list automatically, **pressing Create itself** for every route. It asks for confirmation first, shows a **Stop** button throughout, verifies each route was actually accepted before moving on, and halts on the first one the game refuses rather than continuing blindly.

Routes are **never created twice**: if the source village already sends to that destination, it is skipped and shown as `= exists` rather than `✓`. This matters because Travian merges by destination — a second route to the same village doesn't appear as a duplicate, it silently stacks another schedule onto the existing one. The check is therefore by destination, not by matching amounts, and it makes **Create all** safe to re-run, safe after a reset, and safe after a halted run. To *replace* a route, delete it first.

To start from a clean slate there are also **🗑 this village** and **🗑 all villages**, which drive the game's own delete flow (tick the route's group checkbox → *Edit selected* → the trash button). The all-villages version walks every village you own. Both confirm first and can be stopped mid-run. **Deleting cannot be undone from here** — run **Pull & Sync** beforehand if you want a record of the routes you're removing.

Works with the **Chrome extension** (see `extension/` — plan travels dashboard → `chrome.storage.local` → the game's content script) or the legacy Tampermonkey userscript. Only villages synced from the game (which carry an in-game id) can be applied; harbor/ship routes pre-fill resources but may need the trade-ship option set by hand. Needs Gold Club (recurring routes are a Gold Club feature).

After changing `travian-tool.html` or `travian-commander-sync.user.js`, re-run `python extension/build.py` and reload the extension.

## Notes / disclaimer

Pulling data is read-only. **Apply in game** is not: **Pre-fill ▸** only populates the form and leaves the **Create** click to you, but **▶ Create all** submits the routes itself, and the **🗑 delete** buttons remove existing routes — both are genuine automated game actions, and deletion is destructive with no undo in the tool. Using scripts to assist play, and automated actions in particular, can violate Travian's Terms of Service and put the account at risk. Every automatic mode is opt-in, confirms first, and can be stopped mid-run — but the choice, and the consequences, are yours.
