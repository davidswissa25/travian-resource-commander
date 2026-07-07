# Travian Resource Commander — Chrome extension

Unifies the game data-puller and the dashboard into one Manifest V3 extension.
No Tampermonkey, no `file://` toggle, no cross-origin bridge.

## Architecture

| Piece | File | Role |
|---|---|---|
| Service worker | `background.js` | Toolbar icon → open/focus the dashboard tab |
| Content script | `content.js` | On `*.travian.com`: injects the **⤓ Pull & Sync** button, reads every village (read-only), writes to `chrome.storage.local` |
| Dashboard host | `dashboard.html` + `dashboard.js` | Extension page; frames the tool, bridges `chrome.storage` ↔ the iframe via `postMessage` |
| Dashboard app | `tool.html` | The Resource Commander, run in a **sandboxed** iframe so its inline scripts work under MV3 |

**Data flow:** game tab → content script → `chrome.storage.local` → dashboard bridge → `postMessage` → `applySyncedData()` in the tool.
**Persistence:** the tool's `localStorage` is shimmed to an in-memory store, seeded from / mirrored back to `chrome.storage.local` (the sandboxed page has no real `localStorage`).

## Build

`tool.html` is generated from the canonical `../travian-tool.html` — never edit it by hand.
After any change to the tool, regenerate it:

```
python extension/build.py
```

This injects the sandbox `localStorage` shim (after `<body>`) and the sync listener (before `</body>`).

## Load it (unpacked)

1. `chrome://extensions` → toggle **Developer mode** (top-right).
2. **Load unpacked** → select this `extension/` folder.
3. Pin the extension; click its icon → the **dashboard tab** opens.
4. In your game tab, click **⤓ Pull & Sync** (bottom-right). The dashboard tab fills in automatically.

## After editing the tool

Re-run `python extension/build.py`, then on `chrome://extensions` click the extension's **↻ reload**.

## Known things to verify on first load (report console errors)

- Dashboard tab renders the tool (open DevTools on the tab; check for CSP or `localStorage` errors).
- Pull & Sync toast appears on the game and the dashboard updates.
- Adding/editing a village persists across a dashboard reload (shim round-trip).
