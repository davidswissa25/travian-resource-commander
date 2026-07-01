// ==UserScript==
// @name         Travian Commander - Pull & Sync bridge
// @namespace    travian-commander
// @version      1.5.0
// @description  One-click: a "Pull & Sync" button on the game retrieves every village's tribe, marketplace level, Trade Office level, barracks & stable levels, production, net crop, current resource storages (warehouse/granary stock + capacity), computed merchant capacity and active recurring trade routes, then pushes it straight into the Resource Commander tool (open in another tab) - no console, no file import. Read-only on the game.
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
  const TID = { 1: 'roman', 2: 'teuton', 3: 'gaul', 6: 'egyptian', 7: 'hun', 8: 'spartan' }; // Travian tribeId -> wall class
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

    // Extract a balanced [...] array from `str` starting at/after `from`, skipping
    // over JSON strings so a village name containing a bracket can't break it.
    function sliceArray(str, from) {
      const s = str.indexOf('[', from); if (s < 0) return null;
      let d = 0, inStr = false, esc = false;
      for (let j = s; j < str.length; j++) {
        const c = str[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '[') d++;
        else if (c === ']') { d--; if (!d) return str.slice(s, j + 1); }
      }
      return null;
    }
    // The marketplace "Trade routes" tab (t=3) ships the full route graph as JSON inside
    // Travian.React.TradeRoutes.render({viewData:{...tradeRoutes:[...]}}). Each destination
    // holds a list of scheduled sends that tile a 24h cycle; we sum the ENABLED ones to a
    // daily total and model it as one route at a 24h interval (hourly flow = daily / 24).
    function extractTradeRoutes(html) {
      const raw = sliceArray(html, html.indexOf('"tradeRoutes":'));
      if (!raw) return [];
      let arr; try { arr = JSON.parse(raw); } catch (e) { return []; }
      const out = [];
      arr.forEach(tr => {
        if (!tr || !tr.from || !tr.to || !Array.isArray(tr.routes)) return;
        const tot = { lumber: 0, clay: 0, iron: 0, crop: 0 }; let merch = 0, active = false;
        tr.routes.forEach(r => {
          if (!r || !r.enabled) return;                 // ACTIVE sends only
          active = true; const cr = r.carriedResources || {};
          tot.lumber += cr.lumber || 0; tot.clay += cr.clay || 0; tot.iron += cr.iron || 0; tot.crop += cr.crop || 0;
          if ((r.merchants || 0) > merch) merch = r.merchants || 0;
        });
        if (!active || !(tot.lumber || tot.clay || tot.iron || tot.crop)) return;
        out.push({ fromDid: tr.from.id, toDid: tr.to.id, toName: tr.to.name, resources: tot, intervalHours: 24, merchants: merch });
      });
      return out;
    }

    async function pullAll(onProgress) {
      const root = await getText('/dorf1.php');
      const i = root.indexOf('"villageList":');
      if (i < 0) throw new Error('Not logged into the game world.');
      let d = 0, s = root.indexOf('[', i), j = s;
      for (; j < root.length; j++) { const c = root[j]; if (c === '[') d++; else if (c === ']') { d--; if (!d) { j++; break; } } }
      const list = [];
      JSON.parse(root.slice(s, j)).forEach(e => e.villages ? e.villages.forEach(v => list.push(v)) : list.push(e));

      // account identity, so the tool can keep each account (yours + sitters) in its own profile.
      // playerId (filled from the trade-routes page below) is the reliable unique key; name is for display.
      let player = clean((root.match(/class="playerName"[^>]*>\s*([^<]+?)\s*</) || [])[1] || (root.match(/"ownPlayer":\s*\{[^}]*?"name":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
      const serverName = clean((root.match(/<title>([^<]*)<\/title>/i) || [])[1] || '');
      let playerId = 0;

      const villages = [], routes = [];
      for (let n = 0; n < list.length; n++) {
        const v = list[n];
        if (onProgress) onProgress(n + 1, list.length);
        const d1 = await getText('/dorf1.php?newdid=' + v.id);
        const pm = d1.match(/production:\s*(\{[^}]*\})/); const p = pm ? JSON.parse(pm[1]) : {};
        // current stock + capacity live in the same `resources` object as production
        // (lowercase `storage:` won't match `maxStorage:` thanks to its capital S)
        const stm = d1.match(/storage:\s*(\{[^}]*\})/);    const st = stm ? JSON.parse(stm[1]) : {};
        const mxm = d1.match(/maxStorage:\s*(\{[^}]*\})/); const mx = mxm ? JSON.parse(mxm[1]) : {};
        const stock = k => Math.max(0, Math.round(+st['l' + k] || 0)); // l1 lumber, l2 clay, l3 iron, l4 crop
        const capOf = k => Math.max(0, Math.round(+mx['l' + k] || 0)); // l1-l3 warehouse, l4 granary
        const mkt = lvl(await getText('/build.php?gid=17&newdid=' + v.id));
        const to = lvl(await getText('/build.php?gid=28&newdid=' + v.id), 'Trade Office');
        const bar = lvl(await getText('/build.php?gid=19&newdid=' + v.id)); // gid 19 = Barracks
        const sta = lvl(await getText('/build.php?gid=20&newdid=' + v.id)); // gid 20 = Stable
        const twn = lvl(await getText('/build.php?gid=24&newdid=' + v.id)); // gid 24 = Town Hall (celebrations)
        const d2 = await getText('/dorf2.php?newdid=' + v.id);
        // tribe: prefer the village's tribeId from the page data (reliable even with no wall built),
        // fall back to the wall CSS class, then Romans.
        const tid = +(d1.match(/"village":\s*\{[^}]*?"tribeId":\s*(\d+)/) || [])[1] || 0;
        const wm = d2.match(/class="wall\s+([a-z]+)/i);
        const T = TRIBE[TID[tid] || (wm ? wm[1].toLowerCase() : 'roman')] || TRIBE.roman;
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
          warehouse: { capacity: capOf(1), lumber: stock(1), clay: stock(2), iron: stock(3) },
          granary: { capacity: capOf(4), crop: stock(4) },
          marketplaceLevel: mkt, tradeOfficeLevel: to, merchantCapacityReal: cap,
          tradeShips: ships, shipCapacityReal: shipCap,
          barracksLevel: bar, stableLevel: sta, townHallLevel: twn
        });
        // recurring "Trade routes" for this village (read-only); active sends only
        const rtHtml = await getText('/build.php?gid=17&t=3&newdid=' + v.id);
        if (!playerId) { const m = rtHtml.match(/"ownPlayer":\s*\{\s*"id":\s*(\d+)/); if (m) playerId = +m[1]; }
        if (!player) { const m = rtHtml.match(/class="playerName"[^>]*>\s*([^<]+?)\s*</); if (m) player = clean(m[1]); }
        extractTradeRoutes(rtHtml).forEach(r => routes.push(r));
      }
      const account = { server: location.host, serverName, player, playerId };
      if (list[0]) await getText('/dorf1.php?newdid=' + list[0].id); // restore active village
      villages.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
      return { villages, routes, account };
    }

    async function run(btn) {
      const label = btn ? btn.textContent : '';
      try {
        if (btn) { btn.disabled = true; }
        const { villages, routes, account } = await pullAll((i, t) => { if (btn) btn.textContent = 'Pulling ' + i + '/' + t + '...'; });
        GM_setValue(KEY, { ts: Date.now(), source: 'travian-sync', villages, routes, account });
        toast('✓ ' + (account.player || (account.playerId ? 'player ' + account.playerId : account.serverName) || 'account') + ': pulled ' + villages.length + ' villages, ' + routes.length + ' active routes', '#3fb950');
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
      const res = fn(JSON.stringify({ villages: data.villages, routes: data.routes || [], account: data.account || null }));
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
