// ==UserScript==
// @name         Travian Commander - Pull & Sync bridge
// @namespace    travian-commander
// @version      1.0
// @description  One-click: a "Pull & Sync" button on the game retrieves every village's tribe, marketplace level, Trade Office level, production, net crop and computed merchant capacity, then pushes it straight into the Resource Commander tool (open in another tab) - no console, no file import. Read-only on the game.
// @author       you
// @match        *://*.travian.com/*
// @match        file:///*travian-tool.html*
// @match        *://localhost/*travian-tool.html*
// @match        *://127.0.0.1/*travian-tool.html*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

/*
  HOW TO USE
    1. Install this in Tampermonkey (Dashboard > + > paste > Ctrl+S).
    2. Tampermonkey > this script > Settings: set "Allow access to file URLs"
       (or enable it for the extension in chrome://extensions) so the script can
       run on your file:// tool page.
    3. Open BOTH tabs: your game world AND travian-tool.html.
    4. On the game, click the floating "⤓ Pull & Sync" button (bottom-right).
       The tool tab updates itself instantly.

  Capacity is computed (no slow page loads):
    capacity = base[tribe] * server * (1 + TOrate*TOlevel/100) * (1 + alliance/100)
  If your alliance commerce bonus changes, edit ALLIANCE_BONUS below.
*/

(function () {
  'use strict';

  // ===================== calibration (edit if needed) =======================
  const ALLIANCE_BONUS = 90;   // % merchant-capacity bonus (0 = none)
  const TRIBE = {              // base capacity + Trade-Office %/level, keyed by wall class
    gaul:     { name: 'Gauls',     base: 750,  toRate: 20 },
    roman:    { name: 'Romans',    base: 500,  toRate: 40 },
    teuton:   { name: 'Teutons',   base: 1000, toRate: 20 },
    egyptian: { name: 'Egyptians', base: 750,  toRate: 20 },
    hun:      { name: 'Huns',      base: 500,  toRate: 20 },
    spartan:  { name: 'Spartans',  base: 500,  toRate: 20 }
  };
  const KEY = 'tc_sync';
  // ==========================================================================

  const isTool = /travian-tool\.html$/i.test(location.pathname);
  const isGame = !isTool && /(^|\.)travian\.com$/i.test(location.hostname);

  function toast(msg, color) {
    let t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:64px;right:14px;z-index:2147483647;background:#171e26;color:' +
      (color || '#e6edf3') + ';border:1px solid #2a3744;border-radius:8px;padding:8px 12px;' +
      'font:12px/1.4 -apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:280px';
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 3500);
  }

  /* =======================================================================
     GAME SIDE - the "Pull & Sync" button + retrieval
     ======================================================================= */
  if (isGame) {
    const STRIP = /[‪-‮⁦-⁩]/g;
    const clean = s => String(s == null ? '' : s).replace(STRIP, '').replace(/\s+/g, ' ').trim();
    const getText = u => fetch(u, { credentials: 'same-origin' }).then(r => r.text());
    const title = h => { const dc = new DOMParser().parseFromString(h, 'text/html'); return clean((dc.querySelector('.titleInHeader, h1') || {}).textContent); };
    const lvl = (h, label) => { const t = title(h); if (label && !new RegExp(label, 'i').test(t)) return 0; const m = t.match(/Level\s*(\d+)/i); return m ? +m[1] : 0; };
    const SERVER = (+(location.host.match(/\bx(\d+)\b/) || [])[1]) || 1;

    // per-trade-ship cargo is per-village state on the React send tab -> read via hidden iframe (only when ships>0)
    function readShipCap(did) {
      return new Promise(res => {
        const ifr = document.createElement('iframe');
        ifr.style.cssText = 'position:fixed;width:0;height:0;border:0;left:-9999px';
        let done = false; const fin = v => { if (done) return; done = true; try { ifr.remove(); } catch (e) {} res(v); };
        ifr.onload = async () => {
          for (let k = 0; k < 50; k++) {
            try { const m = clean(ifr.contentDocument.body.innerText).match(/Capacity per trade ship:?\s*([\d,]+)/i); if (m) return fin(parseInt(m[1].replace(/[^\d]/g, ''), 10) || 0); } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
          }
          fin(0);
        };
        ifr.src = '/build.php?gid=17&t=5&newdid=' + did;
        document.body.appendChild(ifr);
        setTimeout(() => fin(0), 15000);
      });
    }

    async function pullAll(onProgress) {
      const root = await getText('/dorf1.php');
      const i = root.indexOf('"villageList":');
      if (i < 0) throw new Error('Not logged into the game world.');
      let d = 0, s = root.indexOf('[', i), j = s;
      for (; j < root.length; j++) { const c = root[j]; if (c === '[') d++; else if (c === ']') { d--; if (!d) { j++; break; } } }
      const list = [];
      JSON.parse(root.slice(s, j)).forEach(e => e.villages ? e.villages.forEach(v => list.push(v)) : list.push(e));

      const villages = [];
      for (let n = 0; n < list.length; n++) {
        const v = list[n];
        if (onProgress) onProgress(n + 1, list.length);
        const d1 = await getText('/dorf1.php?newdid=' + v.id);
        const pm = d1.match(/production:\s*(\{[^}]*\})/); const p = pm ? JSON.parse(pm[1]) : {};
        const mkt = lvl(await getText('/build.php?gid=17&newdid=' + v.id));
        const to = lvl(await getText('/build.php?gid=28&newdid=' + v.id), 'Trade Office');
        const d2 = await getText('/dorf2.php?newdid=' + v.id);
        const wm = d2.match(/class="wall\s+([a-z]+)/i); const T = TRIBE[wm ? wm[1].toLowerCase() : 'roman'] || TRIBE.roman;
        const cap = Math.round(T.base * SERVER * (1 + T.toRate * to / 100) * (1 + ALLIANCE_BONUS / 100));
        const harbor = clean(await getText('/build.php?gid=49&newdid=' + v.id)); // gid 49 = Harbor
        const sm = harbor.match(/trade ?ship[^()]*\(\s*in service\s*(\d+)/i);
        const ships = sm ? +sm[1] : 0;
        const shipCap = ships > 0 ? await readShipCap(v.id) : 0;
        const l4 = p.l4 || 0, l5 = p.l5 || 0;
        villages.push({
          name: v.name, did: v.id, x: v.x, y: v.y, tribe: T.name, synced: true,
          prod: { lumber: p.l1 || 0, clay: p.l2 || 0, iron: p.l3 || 0, crop: l5 },
          baseConsumption: Math.max(0, l5 - l4),
          marketplaceLevel: mkt, tradeOfficeLevel: to, merchantCapacityReal: cap,
          tradeShips: ships, shipCapacityReal: shipCap
        });
      }
      if (list[0]) await getText('/dorf1.php?newdid=' + list[0].id); // restore active village
      villages.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
      return villages;
    }

    async function run(btn) {
      const label = btn ? btn.textContent : '';
      try {
        if (btn) { btn.disabled = true; }
        const villages = await pullAll((i, t) => { if (btn) btn.textContent = 'Pulling ' + i + '/' + t + '...'; });
        GM_setValue(KEY, { ts: Date.now(), source: 'travian-sync', villages });
        toast('✓ Pulled ' + villages.length + ' villages - synced to Commander', '#3fb950');
        if (btn) btn.textContent = '✓ Synced ' + villages.length;
        setTimeout(() => { if (btn) { btn.textContent = label || '⤓ Pull & Sync'; btn.disabled = false; } }, 2500);
      } catch (e) {
        toast('✗ ' + e.message, '#f0533f');
        if (btn) { btn.textContent = label || '⤓ Pull & Sync'; btn.disabled = false; }
      }
    }

    function addButton() {
      if (document.getElementById('tcPullSync')) return;
      const b = document.createElement('button');
      b.id = 'tcPullSync';
      b.textContent = '⤓ Pull & Sync';
      b.title = 'Retrieve all villages and push them to the Resource Commander tab';
      b.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;cursor:pointer;' +
        'background:#1d2630;color:#f5b342;border:1px solid #2a3744;border-radius:8px;padding:8px 12px;' +
        'font:600 12px/1.2 -apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)';
      b.onclick = () => run(b);
      document.body.appendChild(b);
    }
    addButton();
    try { GM_registerMenuCommand('Pull & Sync now', () => run(document.getElementById('tcPullSync'))); } catch (e) {}
  }

  /* =======================================================================
     TOOL SIDE - receive pushed data and import it silently
     ======================================================================= */
  if (isTool) {
    let lastTs = 0;

    function apply(data) {
      if (!data || !data.villages || (data.ts || 0) <= lastTs) return;
      const fn = (unsafeWindow && unsafeWindow.applySyncedData) || window.applySyncedData;
      if (typeof fn !== 'function') return false;          // app not ready yet
      const res = fn(JSON.stringify({ villages: data.villages }));
      lastTs = data.ts || Date.now();
      toast('✓ ' + res, '#3fb950');
      return true;
    }

    // apply whatever is already stored, once the tool app has initialised
    (function waitAndApply(tries) {
      const data = GM_getValue(KEY, null);
      if (data && apply(data) === false && tries > 0) { setTimeout(() => waitAndApply(tries - 1), 300); }
    })(40);

    // live updates whenever the game button pushes new data
    try {
      GM_addValueChangeListener(KEY, (name, oldV, newV) => {
        (function retry(tries) {
          if (apply(newV) === false && tries > 0) setTimeout(() => retry(tries - 1), 300);
        })(40);
      });
    } catch (e) { /* listener unsupported - on-load apply still works after a manual reload */ }
  }
})();
