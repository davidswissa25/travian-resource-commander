// Runs in the PAGE's own world (manifest content_scripts entry with "world": "MAIN"), which is the
// only place the game's fetch/XHR are visible - a normal content script lives in an isolated world
// and cannot see them.
//
// Why this exists: the game answers a successful trade-route create with POST /api/v1/trade-routes
// 201 but leaves the dialog open, and the list behind it does not refresh until the dialog closes.
// Every DOM-based "did it work?" test is therefore a guess about render timing. This reports the
// game's own API result instead, so the Apply panel can wait on fact rather than inference.
//
// It is strictly an observer: it never alters a request, a response, or the page.
(function () {
  'use strict';
  const MATCH = /\/api\/v1\/trade-routes/;

  function report(method, url, status) {
    if (!MATCH.test(String(url || ''))) return;
    try {
      window.postMessage({
        __tcNet: 'trade-routes',
        method: String(method || 'GET').toUpperCase(),
        status: status,
        ok: status >= 200 && status < 300
      }, '*');
    } catch (e) {}
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url = '', method = 'GET';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        method = (init && init.method) || (input && input.method) || 'GET';
      } catch (e) {}
      const p = origFetch.apply(this, arguments);
      try { p.then(res => { try { report(method, url, res && res.status); } catch (e) {} }, () => {}); } catch (e) {}
      return p;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__tcMethod = m; this.__tcUrl = u; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    try { this.addEventListener('loadend', () => { try { report(this.__tcMethod, this.__tcUrl, this.status); } catch (e) {} }); } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();
