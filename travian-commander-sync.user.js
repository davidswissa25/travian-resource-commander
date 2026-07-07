// ==UserScript==
// @name         Travian Commander - Pull & Sync bridge
// @namespace    travian-commander
// @version      1.9.0
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
    // Same balanced-slice idea but for a {...} object (skips over JSON strings).
    function sliceObject(str, from) {
      const s = str.indexOf('{', from); if (s < 0) return null;
      let d = 0, inStr = false, esc = false;
      for (let j = s; j < str.length; j++) {
        const c = str[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') d++;
        else if (c === '}') { d--; if (!d) return str.slice(s, j + 1); }
      }
      return null;
    }
    // production.php ships the per-resource production breakdown inside
    // Travian.React.ProductionOverview.render({...viewData:{lumber:{...},clay,iron,crop}}, [...]).
    // Each resource carries its ACTIVE temporary production boost (the +15% ad boost / +25% Gold
    // boost that can lapse): productionBoostFactor = the % (0 when none), productionBoost = the flat
    // amount it adds, interimBalanceSheet = the base (pre-boost) production, balanceSheet = the boosted
    // production (this equals the value in `var resources`). We keep the boost AMOUNT so the tool can
    // recover exact base production as (synced prod - amount) - no lossy division, and per resource,
    // since wood/clay/iron and crop can carry different boosts.
    function extractBoost(html) {
      const idx = html.indexOf('ProductionOverview.render(');
      if (idx < 0) return null;
      const raw = sliceObject(html, idx);
      if (!raw) return null;
      let obj; try { obj = JSON.parse(raw); } catch (e) { return null; }
      const vd = obj && obj.viewData; if (!vd) return null;
      const pct = {}, amt = {};
      // productionBoostFactor/productionBoost are the CONFIGURED boost - present on every resource
      // even when it is not currently active. The ACTUAL applied boost is balanceSheet minus
      // interimBalanceSheet (0 for a resource whose ad/Gold boost has lapsed), so each resource is
      // detected independently - not "+25% on everything" just because the factor is set.
      ['lumber', 'clay', 'iron', 'crop'].forEach(k => {
        const r = vd[k] || {};
        const base = +r.interimBalanceSheet || 0;          // pre-boost production
        const now = +r.balanceSheet || 0;                  // current production (matches `var resources`)
        const a = Math.max(0, now - base);                 // boost currently applied (0 when inactive)
        amt[k] = a;
        pct[k] = (a > 0 && base > 0) ? Math.round((now / base - 1) * 100) : 0;
      });
      return { pct, amt };
    }
    // Town Hall Celebrations tab (gid=24&t=1): an active celebration is shown in
    // <table class="under_progress"> with <td class="desc">Great/Small celebration</td> and a
    // <td class="dur"><span class="timer" ... value="<seconds-left>">. No table => none running.
    // We scope the parse to that table so the page's other timers (server clock etc.) can't match.
    function extractCelebration(html) {
      const t = html.match(/class="under_progress"[\s\S]*?<\/table>/i);
      if (!t) return null;
      const seg = t[0];
      const tm = seg.match(/class="timer"[^>]*\bvalue="(\d+)"/i);
      if (!tm) return null;
      const secs = parseInt(tm[1], 10) || 0;
      if (secs <= 0) return null;
      const dm = seg.match(/class="desc"[^>]*>([^<]+)</i);
      const desc = dm ? clean(dm[1]) : '';
      return { active: true, type: /great/i.test(desc) ? 'great' : 'small',
        secondsLeft: secs, endsAt: Date.now() + secs * 1000 };
    }
    // The marketplace "Trade routes" tab (t=3) ships the full route graph as JSON inside
    // Travian.React.TradeRoutes.render({viewData:{...tradeRoutes:[...]}}). Each destination has a
    // list of scheduled sends. We take the PER-SEND amount and derive the interval from the actual
    // gap between departure times, so hourly flow = perSend / interval - correct no matter how many
    // sends the list spans (the old "sum all / 24h" was wrong when they didn't tile exactly 24h).
    function extractTradeRoutes(html) {
      const raw = sliceArray(html, html.indexOf('"tradeRoutes":'));
      if (!raw) return [];
      let arr; try { arr = JSON.parse(raw); } catch (e) { return []; }
      const out = [], keys = ['lumber', 'clay', 'iron', 'crop'];
      arr.forEach(tr => {
        if (!tr || !tr.from || !tr.to || !Array.isArray(tr.routes)) return;
        const sends = tr.routes.filter(r => r && r.enabled).sort((a, b) => (a.departureAt || 0) - (b.departureAt || 0));
        if (!sends.length) return;
        // per-send resources = average across the day's sends (normally all identical), and merchants
        const per = { lumber: 0, clay: 0, iron: 0, crop: 0 }; let merch = 0;
        sends.forEach(r => { const cr = r.carriedResources || {}; keys.forEach(k => per[k] += cr[k] || 0); if ((r.merchants || 0) > merch) merch = r.merchants || 0; });
        keys.forEach(k => per[k] = Math.round(per[k] / sends.length));
        if (!keys.some(k => per[k])) return;
        // interval = median gap between consecutive departures (seconds -> whole hours); 1 send -> daily
        let intervalHours = 24;
        if (sends.length >= 2) {
          const gaps = []; for (let i = 1; i < sends.length; i++) gaps.push((sends[i].departureAt || 0) - (sends[i - 1].departureAt || 0));
          gaps.sort((a, b) => a - b); const med = gaps[Math.floor(gaps.length / 2)];
          if (med > 0) intervalHours = Math.max(1, Math.min(24, Math.round(med / 3600)));
        }
        out.push({ fromDid: tr.from.id, toDid: tr.to.id, toName: tr.to.name, resources: per, intervalHours: intervalHours, merchants: merch });
      });
      return out;
    }

    // Parse trainable units from a Barracks/Stable page: real per-server cost + the training
    // time AT THIS village's current building level (already includes level & bonuses), so the
    // sustainable rate is simply 3600 / seconds. No hardcoded unit table needed.
    function parseUnits(html, building) {
      const out = []; let doc;
      try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return out; }
      doc.querySelectorAll('.innerTroopWrapper[data-troopID]').forEach(w => {
        const id = w.getAttribute('data-troopID');
        const name = (w.innerHTML.match(/unitZoom\(\s*\d+\s*,\s*'([^']*)'/) || [])[1] || id;
        const cost = { lumber: 0, clay: 0, iron: 0, crop: 0 };
        w.querySelectorAll('.resourceWrapper .inlineIcon.resource').forEach(r => {
          const t = (r.getAttribute('title') || '').toLowerCase();
          const val = parseInt(clean((r.querySelector('.value') || {}).textContent).replace(/[^\d]/g, ''), 10) || 0;
          if (t === 'lumber') cost.lumber = val; else if (t === 'clay') cost.clay = val;
          else if (t === 'iron') cost.iron = val; else if (t === 'crop') cost.crop = val;
        });
        const p = clean((w.querySelector('.inlineIcon.duration .value') || {}).textContent).split(':').map(n => +n || 0);
        const secs = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : 0;
        if (secs > 0) out.push({ id, name, building, cost, seconds: secs });
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
        // production.php is a superset of dorf1.php: same `var resources` (production/storage/maxStorage)
        // and village tribeId, PLUS the per-resource production-boost breakdown - so one fetch, no extra request.
        const d1 = await getText('/production.php?t=lumber&newdid=' + v.id);
        const pm = d1.match(/production:\s*(\{[^}]*\})/); const p = pm ? JSON.parse(pm[1]) : {};
        const boost = extractBoost(d1); // {pct:{lumber,clay,iron,crop}, amt:{...}} or null
        // current stock + capacity live in the same `resources` object as production
        // (lowercase `storage:` won't match `maxStorage:` thanks to its capital S)
        const stm = d1.match(/storage:\s*(\{[^}]*\})/);    const st = stm ? JSON.parse(stm[1]) : {};
        const mxm = d1.match(/maxStorage:\s*(\{[^}]*\})/); const mx = mxm ? JSON.parse(mxm[1]) : {};
        const stock = k => Math.max(0, Math.round(+st['l' + k] || 0)); // l1 lumber, l2 clay, l3 iron, l4 crop
        const capOf = k => Math.max(0, Math.round(+mx['l' + k] || 0)); // l1-l3 warehouse, l4 granary
        const mkt = lvl(await getText('/build.php?gid=17&newdid=' + v.id));
        const to = lvl(await getText('/build.php?gid=28&newdid=' + v.id), 'Trade Office');
        const barHtml = await getText('/build.php?gid=19&newdid=' + v.id), bar = lvl(barHtml); // gid 19 = Barracks
        const staHtml = await getText('/build.php?gid=20&newdid=' + v.id), sta = lvl(staHtml); // gid 20 = Stable
        const wspHtml = await getText('/build.php?gid=21&newdid=' + v.id), wsp = lvl(wspHtml); // gid 21 = Workshop (rams/catapults)
        const trainable = parseUnits(barHtml, 'barracks').concat(parseUnits(staHtml, 'stable'), parseUnits(wspHtml, 'workshop')); // real per-server unit cost + training time
        const thHtml = await getText('/build.php?gid=24&t=1&newdid=' + v.id); // gid 24 t=1 = Town Hall, Celebrations tab
        const twn = lvl(thHtml);
        const celebration = extractCelebration(thHtml); // {active,type,secondsLeft,endsAt} or null
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
          prodBoostPct: boost ? boost.pct : { lumber: 0, clay: 0, iron: 0, crop: 0 }, // active boost % per resource (0=none)
          prodBoost: boost ? boost.amt : { lumber: 0, clay: 0, iron: 0, crop: 0 },     // flat /h the boost adds -> base = prod - this
          baseConsumption: Math.max(0, l5 - l4),
          warehouse: { capacity: capOf(1), lumber: stock(1), clay: stock(2), iron: stock(3) },
          granary: { capacity: capOf(4), crop: stock(4) },
          marketplaceLevel: mkt, tradeOfficeLevel: to, merchantCapacityReal: cap,
          tradeShips: ships, shipCapacityReal: shipCap,
          barracksLevel: bar, stableLevel: sta, workshopLevel: wsp, townHallLevel: twn, trainable,
          celebration // {active,type,secondsLeft,endsAt} or null (null = no celebration running now)
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
