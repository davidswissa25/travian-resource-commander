// Parent bridge for the dashboard page (has chrome.* access; the sandboxed tool iframe does not).
//  - Seeds the tool's localStorage snapshot into the iframe on load (via the URL hash).
//  - Persists the tool's saves back to chrome.storage.local.
//  - Forwards freshly pulled game data (written by the content script) into the iframe.
const SYNC_KEY = 'tc_sync';    // latest game pull, written by content.js
const STORE_KEY = 'tc_store';  // persisted snapshot of the tool's localStorage
const APPLY_KEY = 'tc_apply';  // plan of routes to create in-game, read by content.js's Apply panel
const enc = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj || {}))));

const iframe = document.getElementById('app');
let ready = false, pendingSync = null;

function postSync(data) {
  if (!data || !data.villages || !iframe.contentWindow) return;
  const payload = JSON.stringify({ villages: data.villages, routes: data.routes || [], account: data.account || null });
  iframe.contentWindow.postMessage({ __tc: 'sync', payload }, '*');
}

window.addEventListener('message', ev => {
  const d = ev && ev.data; if (!d || !d.__tc) return;
  if (d.__tc === 'save') {
    chrome.storage.local.set({ [STORE_KEY]: d.store || {} });
  } else if (d.__tc === 'apply') {
    // "Apply in game": stash the proposed routes for the game tab's ⚡ Apply routes panel, which
    // pre-fills the in-game create form for each (the user still presses Create themselves).
    const plan = d.plan || {};
    chrome.storage.local.set({ [APPLY_KEY]: { ts: Date.now(), account: plan.account || null, routes: plan.routes || [] } });
  } else if (d.__tc === 'ready') {
    ready = true;
    if (pendingSync) { postSync(pendingSync); pendingSync = null; }
  }
});

// New data pushed by the content script while the dashboard is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SYNC_KEY]) return;
  const data = changes[SYNC_KEY].newValue;
  if (ready) postSync(data); else pendingSync = data;
});

// Boot: seed persisted tool state, and queue any already-stored pull to apply once ready.
(async function boot() {
  const o = await chrome.storage.local.get([STORE_KEY, SYNC_KEY]);
  if (o[SYNC_KEY]) pendingSync = o[SYNC_KEY];
  iframe.src = 'tool.html#' + enc(o[STORE_KEY] || {});
})();
