// ==UserScript==
// @name         Travian Commander - Pull & Sync bridge
// @namespace    travian-commander
// @version      1.13.0
// @description  One-click: a "Pull & Sync" button on the game retrieves every village's tribe, marketplace level, Trade Office level, barracks & stable levels, production, net crop, current resource storages (warehouse/granary stock + capacity), computed merchant capacity and active recurring trade routes, then pushes it straight into the Resource Commander tool (open in another tab) - no console, no file import. It also applies the tool's suggested routes: an "Apply routes" panel pre-fills the in-game Create-trade-route form per route for you to confirm, and can optionally create them all, or delete existing routes, on its own. Pulling is read-only; creating and deleting are opt-in, confirm first and can be stopped mid-run.
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
    // Treasury page (gid=27&newdid=X) - village-contextual: the "ancient power activated for THIS village"
    // is the power X currently has running. We look in <table class="show_artefacts"> for a Trainer power
    // (name contains "trainer") whose row is marked "activated for this village" - that means the viewed
    // village X trains faster. The .info cell gives the scope: "Effect Village" (only X) vs "Effect all
    // villages" (every village); the bonus (1/2, 1/3) gives the factor. Returns {scope,factor} for the
    // trainer active in THIS village, or null. Defensive: never throws; villages with no Treasury redirect
    // to dorf2 (no show_artefacts) -> null.
    function extractTrainer(html) {
      if (!/show_artefacts/.test(html)) return null; // not a Treasury page (redirected / no treasury here)
      let doc; try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }
      let best = null;
      doc.querySelectorAll('table.show_artefacts tr').forEach(tr => {
        const txt = clean(tr.textContent);
        if (!/trainer/i.test(txt)) return;                                   // trainer power only
        if (!/activated for this village/i.test(txt)) return;                // running for THIS village (idle/other rows skipped)
        const factor = /1\s*\/\s*3/.test(txt) ? 3 : 2;                       // (1/2) -> half, (1/3) -> a third
        const scope = /all villages/i.test(txt) ? 'all' : 'village';         // "Effect all villages" vs "Effect Village"
        if (!best || (scope === 'all' && best.scope !== 'all')) best = { active: true, scope: scope, factor: factor };
      });
      return best;
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
        // per-send resources = average across the day's sends (normally all identical), and carriers
        const per = { lumber: 0, clay: 0, iron: 0, crop: 0 }; let merch = 0, ships = 0, useShips = false;
        sends.forEach(r => { const cr = r.carriedResources || {}; keys.forEach(k => per[k] += cr[k] || 0);
          if ((r.merchants || 0) > merch) merch = r.merchants || 0;
          if ((r.ships || 0) > ships) ships = r.ships || 0;
          if (r.useTradeShips) useShips = true; });
        keys.forEach(k => per[k] = Math.round(per[k] / sends.length));
        if (!keys.some(k => per[k])) return;
        // REAL one-way travel time (median arrivalAt - departureAt): exact even over water paths;
        // the dashboard caches it per pair+kind and prefers it over distance/speed estimates
        const travs = sends.map(r => Math.max(0, (r.arrivalAt || 0) - (r.departureAt || 0))).filter(s => s > 0).sort((a, b) => a - b);
        const travelSec = travs.length ? travs[Math.floor(travs.length / 2)] : 0;
        // interval = median gap between consecutive departures (seconds -> whole hours); 1 send -> daily
        let intervalHours = 24;
        if (sends.length >= 2) {
          const gaps = []; for (let i = 1; i < sends.length; i++) gaps.push((sends[i].departureAt || 0) - (sends[i - 1].departureAt || 0));
          gaps.sort((a, b) => a - b); const med = gaps[Math.floor(gaps.length / 2)];
          if (med > 0) intervalHours = Math.max(1, Math.min(24, Math.round(med / 3600)));
        }
        // minute offset within each repeat cycle (staggering) - position of the first send in the interval
        const offsetHours = ((sends[0].departureAt || 0) % (intervalHours * 3600)) / 3600;
        out.push({ fromDid: tr.from.id, toDid: tr.to.id, toName: tr.to.name, resources: per, intervalHours: intervalHours, offsetHours: offsetHours, merchants: merch, ships: ships, kind: useShips ? 'ship' : 'merchant', travelSec: travelSec });
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
      let allTrainer = null; // set to {factor} if an "all villages" Trainer power is active (affects every village)
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
        // Treasury (gid=27) for THIS village: the trainer power "activated for this village" (if any) tells
        // us this village trains faster. A Village-scope trainer is attributed to this village; an all-scope
        // one is remembered and stamped on every village after the loop.
        const tre = extractTrainer(await getText('/build.php?gid=27&newdid=' + v.id));
        if (tre && tre.scope === 'all') allTrainer = { factor: tre.factor };
        const l4 = p.l4 || 0, l5 = p.l5 || 0;
        villages.push({
          name: v.name, did: v.id, x: v.x, y: v.y, tribe: T.name, synced: true,
          trainerActive: !!(tre && tre.scope === 'village'), trainerFactor: (tre && tre.factor) || 2, // small Trainer running in THIS village (overwritten below if an all-villages one is active)
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
      // An "all villages" Trainer power shortens training everywhere, so stamp every village.
      if (allTrainer) villages.forEach(vv => { vv.trainerActive = true; vv.trainerFactor = allTrainer.factor; });
      const account = { server: location.host, serverName, player, playerId, trainer: allTrainer ? { scope: 'all', factor: allTrainer.factor } : null };
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
    /* ---------- APPLY suggested routes (semi-auto: pre-fill the create form, YOU confirm) ----------
       The tool pushes a plan of routes (keyed by game did) into GM storage; here we render an
       "Apply routes" panel. Per route we jump to its SOURCE village's marketplace Trade-routes tab,
       open "Create new trade route", and pre-fill every field - then highlight Create for the user
       to review and click. Create is NEVER clicked programmatically. */
    const APPLY_KEY = 'tc_apply', AS_KEY = 'tc_apply_state';
    const IVS = [1, 2, 3, 4, 6, 8, 12, 24];
    const snapIv = h => IVS.reduce((b, x) => Math.abs(x - h) < Math.abs(b - h) ? x : b, IVS[0]);
    const escH = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const nfmt = n => Math.round(+n || 0).toLocaleString();
    // React-controlled inputs ignore a plain el.value= (a value tracker suppresses the change). Set
    // through the prototype setter and fire input+change so React's own state updates too.
    const setNative = (el, val) => {
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const waitEl = (fn, ms = 8000) => new Promise((res, rej) => {
      const t0 = Date.now();
      (function loop() { let v; try { v = fn(); } catch (e) {} if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('the trade-route form did not appear')); setTimeout(loop, 150); })();
    });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // The dialog's time picker is in SERVER time, but the browser's clock can be in another zone
    // (observed here: browser 2h ahead of the server), which would schedule every route off by that
    // drift. Read the game's own "Server time: HH:MM:SS" header and count the offset from that.
    function serverNow() {
      const d = new Date();
      const m = (document.body.innerText || '').match(/Server time:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (!m) return d;                                    // no clock on this page: fall back to local
      const s = new Date(d);
      s.setHours(+m[1], +m[2], +(m[3] || 0), 0);
      return s;
    }
    const applyState = () => { try { return GM_getValue(AS_KEY, null) || { ts: 0, done: {}, pending: null, dismissed: 0 }; } catch (e) { return { ts: 0, done: {}, pending: null, dismissed: 0 }; } };
    const setApplyState = s => { try { GM_setValue(AS_KEY, s); } catch (e) {} };
    // Pace the form filling so you can actually watch each field land. The pause is drawn fresh from a
    // user-set [min,max] range before every field, so it varies instead of ticking like a metronome.
    // Range lives in the apply state, so it survives the navigation between routes. Both 0 = instant.
    const STEP_MIN_DEFAULT = 300, STEP_MAX_DEFAULT = 700;
    const stepRange = () => {
      const s = applyState();
      let lo = s.stepMin, hi = s.stepMax;
      if (lo == null && hi == null && s.stepMs != null) lo = hi = +s.stepMs || 0;   // migrate the old single speed
      lo = lo == null ? STEP_MIN_DEFAULT : Math.max(0, +lo || 0);
      hi = hi == null ? STEP_MAX_DEFAULT : Math.max(0, +hi || 0);
      if (hi < lo) { const t = lo; lo = hi; hi = t; }                               // tolerate an inverted range
      return [lo, hi];
    };
    const stepMs = () => { const r = stepRange(); return r[1] <= 0 ? 0 : r[0] + Math.floor(Math.random() * (r[1] - r[0] + 1)); };
    // One user-paced beat, used between every visible step of filling, creating and deleting. Waiting
    // for an element to be ready is always done with waitEl instead, so setting the delay to 0 only
    // makes things fast - it can never make a run fail.
    const pause = () => sleep(stepMs());
    // Number of scheduled-send rows listed for the village on screen. The create dialog does NOT close
    // on success - the game leaves it open - so "the dialog went away" is not a completion signal (it
    // never happens). A new row appearing in the list is, and it is also what tells a real rejection
    // apart from a success. List rows carry an unnamed checkbox; the dialog's own are named.
    const listRowCount = () => [...document.querySelectorAll('input[type=checkbox]')]
      .filter(c => !c.name && !c.closest('#tcApplyPanel')).length;
    // The game's own answer, relayed by the MAIN-world hook (extension/page-hook.js): a trade-route
    // create/delete API call and its status. This is fact rather than inference, so it beats any
    // DOM-based guess about when the dialog closes or the list re-renders.
    const netSeen = { POST: 0, DELETE: 0, any: 0 };
    window.addEventListener('message', ev => {
      const d = ev && ev.data;
      if (!d || d.__tcNet !== 'trade-routes' || ev.source !== window) return;
      netSeen.any = Date.now();
      if (d.ok && netSeen[d.method] !== undefined) netSeen[d.method] = Date.now();
    });
    const confirmedByGame = (method, since, ms) => waitEl(() => netSeen[method] > since ? true : null, ms || 9000).then(() => true, () => false);
    // Does the village on screen already send to `toName`? Travian merges by destination: creating a
    // second route to the same village does NOT make a separate one, it stacks another schedule onto
    // the existing route. So ANY match matters - matching only "identical" amounts/interval would let
    // the damaging case through, which is exactly how routes end up sending several times over.
    function existingRouteTo(toName) {
      const want = String(toName || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!want) return false;
      return [...document.querySelectorAll('*')].some(e => {
        if (e.children.length > 3) return false;
        const t = (e.textContent || '').trim();
        if (!/^To:\s/.test(t)) return false;
        const name = t.split('\n')[0].replace(/^To:\s*/, '').replace(/Travel.*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
        return name === want;
      });
    }
    const dismissDialog = () => { const c = [...document.querySelectorAll('button')].find(b => /^\s*Cancel\s*$/i.test(b.textContent || '')); if (c) { c.click(); return true; } return false; };
    // Panel order == batch order, so "create all" works down the list exactly as displayed.
    const collate = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
    const orderRoutes = list => (list || []).slice().sort((a, b) => collate(a.fromName, b.fromName) || collate(a.toName, b.toName));
    // Keep a dragged panel on screen (the window may be smaller than when the spot was chosen):
    // always leave its header grabbable rather than letting it strand off an edge.
    const clampPos = (x, y, el) => {
      const w = (el && el.offsetWidth) || 332;
      return [Math.max(0, Math.min(x, Math.max(0, window.innerWidth - Math.min(w, 120)))),
              Math.max(0, Math.min(y, Math.max(0, window.innerHeight - 36)))];
    };
    // Briefly outline a field as it is filled, so the eye can follow which one just changed.
    const flash = el => {
      if (!el) return;
      const o = el.style.outline, b = el.style.boxShadow;
      el.style.outline = '2px solid #f5b342'; el.style.boxShadow = '0 0 8px rgba(245,179,66,.9)';
      setTimeout(() => { el.style.outline = o; el.style.boxShadow = b; }, 450);
    };

    // Fill the (already-open) "Create trade route" dialog for one route; highlight Create at the end.
    async function fillCreateDialog(route) {
      // Wait until the destination <select> is POPULATED - i.e. React has finished mounting the dialog.
      // Filling before that lets React's initial render clobber the values (fields snap back to empty),
      // so wait for options, let it settle, fill, then verify and fill once more if it was reset.
      const dest = await waitEl(() => { const s = document.querySelector('select[name="did_dest"]'); return s && s.options.length > 1 ? s : null; });
      await sleep(300);
      // Merchants vs trade ships is a checkbox ("Use trade ships"), present only on harbour villages.
      // It switches the per-carrier capacity the dialog uses (e.g. 1,900 -> 9,500), so set it BEFORE the
      // amounts. A plain .click() is what this React checkbox registers; setting .checked does nothing.
      const paced = stepRange()[1] > 0;                      // false => fill instantly
      const ship = document.querySelector('input[name="useTradeShips"]');
      const shipMissing = !!route.useShips && !ship;
      if (ship && !!ship.checked !== !!route.useShips) { flash(ship); try { ship.click(); } catch (e) {} await pause(); }
      // Filled one field at a time (each briefly outlined) so the sequence is watchable, with a fresh
      // random pause before each; the retry pass below runs instantly, since it only exists to
      // re-assert values React may have reset.
      const fill = async (pace) => {
        const set = (el, val) => { setNative(el, val); if (pace) flash(el); };
        const gap = async () => { if (pace) await sleep(stepMs()); };
        set(dest, route.toDid); await gap();
        set(document.querySelector('input[name="r1"]'), route.res.lumber || 0); await gap();
        set(document.querySelector('input[name="r2"]'), route.res.clay || 0); await gap();
        set(document.querySelector('input[name="r3"]'), route.res.iron || 0); await gap();
        set(document.querySelector('input[name="r4"]'), route.res.crop || 0); await gap();
        set(document.querySelector('select[name="repeatEvery"]'), snapIv(route.interval || 1)); await gap();
        // Departure = server clock + the plan's stagger offset, rounded UP to a whole hour - every
        // allowed interval (1/2/3/4/6/8/12/24h) divides the day, so starting on the hour keeps every
        // send on clean clock times instead of some arbitrary :37. Rounding up also leaves you a moment
        // to review and press Create before the first send is due. This input is an UNCONTROLLED React
        // field (props are type/name/size/disabled/defaultValue - no value/onChange), so the game reads
        // the DOM at submit and setting .value is what counts; React never overwrites it.
        const tEl = document.querySelector('input[name="time"]');
        if (tEl) {
          const d = new Date(serverNow().getTime() + (route.offsetHours || 0) * 3600000);
          d.setSeconds(0, 0);
          if (d.getMinutes() > 0) { d.setMinutes(0); d.setHours(d.getHours() + 1); }
          set(tEl, String(d.getHours()).padStart(2, '0') + ':00');
        }
      };
      await fill(paced); await sleep(200);
      if (String(dest.value) !== String(route.toDid)) { await sleep(300); await fill(false); await sleep(150); }
      if (String(dest.value) !== String(route.toDid)) throw new Error('"' + route.toName + '" is not selectable from ' + route.fromName + ' (not in its destination list)');
      // clear the stale "No resources selected" message (React shows it until a field is blurred)
      ['r1', 'r2', 'r3', 'r4'].forEach(n => { const el = document.querySelector('[name="' + n + '"]'); if (el) { el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); } });
      // Highlight Create so it is obvious what to confirm. A React re-render (triggered by the blur
      // above) wipes an inline style, so re-apply it a few times over the next second.
      const glow = () => { const c = [...document.querySelectorAll('button')].find(b => /^\s*Create trade route\s*$/i.test(b.textContent || '')); if (c) c.style.boxShadow = '0 0 0 3px #f5b342, 0 0 16px #f5b342'; return c; };
      const create = glow();
      [250, 700, 1400].forEach(ms => setTimeout(glow, ms));
      if (create) { try { create.scrollIntoView({ block: 'center' }); } catch (e) {} }
      return { shipMissing: shipMissing };
    }

    // Open the create dialog on the current (source) village and fill it.
    async function prefillHere(route) {
      const btn = await waitEl(() => [...document.querySelectorAll('button, a, div, span')].find(e => /^\s*Create new trade route\s*$/i.test((e.textContent || '').trim()) && e.offsetParent && e.getBoundingClientRect().height < 90));
      btn.click();
      const r = await fillCreateDialog(route);
      const shipNote = (r && r.shipMissing) ? ' NOTE: planned for trade ships, but ' + route.fromName + ' offers no "Use trade ships" option - it will go by merchants.' : '';
      // during an automatic batch the "click Create" prompt would be wrong - applyOne reports instead
      if ((applyState().auto || {}).on) { if (shipNote) toast(route.fromName + ' → ' + route.toName + ':' + shipNote, '#f0a92b'); }
      else toast('Pre-filled ' + route.fromName + ' → ' + route.toName + '. Review it and click "Create trade route".' + shipNote
        + (existingRouteTo(route.toName) ? ' WARNING: this village already sends to ' + route.toName + ' - creating this stacks a second schedule onto that route rather than making a new one.' : ''), '#f5b342');
    }

    /* ----- automatic batch: fill AND submit every route that isn't done yet -----
       Unlike Pre-fill (which stops at the filled form for you), this presses Create itself. It walks
       the panel's order, only reloading when the source village changes, verifies each route really
       was created before counting it, and halts on the first thing it can't do rather than plough on. */
    let autoBusy = false;
    function stopAuto(msg, finished) {
      const s = applyState(); s.auto = null; s.pending = null; setApplyState(s);
      renderApplyPanel();
      if (finished) toast('✓ Done - the game now matches the plan.', '#3fb950');
      else if (msg) toast('Apply stopped: ' + msg, '#f0533f');
      return false;
    }
    // Apply ONE changeset op on the village currently on screen. "delete" removes the named route and
    // stops there; "update" removes it and falls through to re-create it with the new amounts; "create"
    // (also the default for plans made before ops existed) just creates.
    async function applyOne(route) {
      const op = route.op || 'create';
      if (op === 'delete' || op === 'update') {
        const res = await deleteRouteTo(route.toName);
        if (res === 'fail') return stopAuto('could not delete ' + route.fromName + ' → ' + route.toName);
        if (op === 'delete') {
          const s0 = applyState();
          (s0.done = s0.done || {})[route.id] = true;
          if (res === 'missing') (s0.skipped = s0.skipped || {})[route.id] = true;
          setApplyState(s0);
          toast((res === 'missing' ? '= ' : '🗑 ') + route.fromName + ' → ' + route.toName +
                (res === 'missing' ? ' — no such route, nothing to delete' : ' deleted'), res === 'missing' ? '#8b9aa8' : '#3fb950');
          renderApplyPanel();
          await pause();
          return true;
        }
        await pause();                                          // replaced: now create it fresh below
      }
      // Never create a second route to a destination this village already serves - it would stack a
      // schedule onto the existing one rather than show up as a duplicate. Skipping instead of failing
      // makes "Apply all" safe to re-run, and safe after a reset or a halted run. (An update already
      // deleted its old route above, so this cannot swallow a replace.)
      if (existingRouteTo(route.toName)) {
        const s0 = applyState();
        (s0.done = s0.done || {})[route.id] = true;
        (s0.skipped = s0.skipped || {})[route.id] = true;
        setApplyState(s0);
        toast('= ' + route.fromName + ' → ' + route.toName + ' already exists - skipped', '#8b9aa8');
        renderApplyPanel();
        await pause();
        return true;
      }
      const rowsBefore = listRowCount();                        // measured with no dialog covering the list
      try { await prefillHere(route); }
      catch (e) { return stopAuto('could not fill ' + route.fromName + ' → ' + route.toName + ' (' + e.message + ')'); }
      const btn = [...document.querySelectorAll('button')].find(b => /^\s*Create trade route\s*$/i.test(b.textContent || ''));
      if (!btn) return stopAuto('the Create button was not found');
      if (!(applyState().auto || {}).on) return false;            // stopped while the form was filling
      await pause();                                            // beat before the destructive click
      const t0 = Date.now();
      btn.click();                                              // exactly once - a retry would duplicate the route
      // Wait for the game's own POST /api/v1/trade-routes to come back OK. Never re-click on failure:
      // the POST may well have succeeded anyway, and a second click silently stacks another schedule
      // onto the same route (exactly how the duplicates were made).
      let ok = await confirmedByGame('POST', t0);
      // the dialog stays up after a successful create, so dismiss it either way; this undoes nothing
      dismissDialog();
      await sleep(400);
      // Only if the page hook isn't there at all (older extension build / Tampermonkey) fall back to
      // the list growing - which is checked here, after dismissing, because it does not refresh while
      // the dialog is up. That ordering was the bug in the previous two attempts.
      if (!ok && !netSeen.any) ok = await waitEl(() => listRowCount() > rowsBefore ? true : null, 6000).then(() => true, () => false);
      if (!ok) return stopAuto('the game did not confirm ' + route.fromName + ' → ' + route.toName + ' - it may still have been created, so check before re-running');
      const s = applyState(); (s.done = s.done || {})[route.id] = true; setApplyState(s);
      const plan0 = GM_getValue(APPLY_KEY, null), total = (plan0 && plan0.routes || []).length;
      const madeCount = Object.keys(s.done).length;
      toast('✓ ' + madeCount + '/' + total + '  ' + route.fromName + ' → ' + route.toName, '#3fb950');
      renderApplyPanel();
      await pause();
      return true;
    }
    // Queue the next route and reload into its source village. Every route goes through a page load,
    // even consecutive ones from the same village: after a create the marketplace is left in a state
    // where the next attempt stalls, and a fresh page reliably clears it (reloading by hand was what
    // un-stuck a stalled run). The reload also guarantees an up-to-date route list to compare against.
    async function autoLoop() {
      if (autoBusy) return;                                       // never run two batches at once
      autoBusy = true;
      try {
        const st0 = applyState();
        if (!st0.auto || !st0.auto.on) return;                    // stopped by the user
        const plan = GM_getValue(APPLY_KEY, null);
        if (!plan || !plan.routes) return stopAuto('the plan is no longer available');
        const next = orderRoutes(plan.routes).find(r => !(st0.done || {})[r.id]);
        if (!next) return stopAuto(null, true);
        const s = applyState();
        s.pending = { rid: next.id, auto: true }; s.auto.curDid = next.fromDid; setApplyState(s);
        await sleep(Math.max(200, stepMs()));       // floor: let the async storage write land before unload
        location.href = '/build.php?gid=17&t=3&newdid=' + next.fromDid;
      } finally { autoBusy = false; }                             // resumeApply() takes over after the load
    }

    /* ----- delete existing trade routes -----
       The game's own flow, automated: tick a route's group checkbox (which selects all of that
       route's scheduled sends), press "Edit selected", then the trash button in the dialog. Repeats
       until a village has none left, optionally walking every village. Destructive and not undoable
       from here, so both entry points confirm first. */
    let delBusy = false;
    function stopDelete(msg, finished) {
      const s = applyState(); const n = (s.del || {}).removed || 0;
      s.del = null; setApplyState(s); renderApplyPanel();
      if (finished) toast('✓ Deleted ' + n + ' trade route(s).', '#3fb950');
      else if (msg) toast('Delete stopped after ' + n + ': ' + msg, '#f0533f');
      return false;
    }
    // Every village of this account, as [{id,name}] - same villageList the puller reads.
    async function villageDids() {
      const root = await getText('/dorf1.php');
      const i = root.indexOf('"villageList":');
      if (i < 0) throw new Error('not logged into the game world');
      let d = 0, s = root.indexOf('[', i), j = s;
      for (; j < root.length; j++) { const c = root[j]; if (c === '[') d++; else if (c === ']') { d--; if (!d) { j++; break; } } }
      const out = [];
      JSON.parse(root.slice(s, j)).forEach(e => e.villages ? e.villages.forEach(v => out.push({ id: v.id, name: v.name })) : out.push({ id: e.id, name: e.name }));
      return out;
    }
    // Remove every route on the trade-routes tab currently open.
    async function deleteHere(v) {
      for (let guard = 0; ; guard++) {
        if (guard > 40) return stopDelete('too many attempts on one village - something is not clearing');
        const s0 = applyState(); if (!s0.del || !s0.del.on) return false;
        const boxes = [...document.querySelectorAll('input[type=checkbox]')].filter(c => c.offsetParent && !c.closest('#tcApplyPanel'));
        // the group checkbox is the one on the "Resource" header row; ticking it selects that whole route
        const head = boxes.find(c => { const r = c.closest('tr,div'); return r && /^Resource\b/.test(((r.innerText) || '').trim()); });
        if (!head) return true;                                    // nothing left in this village
        if (!head.checked) head.click();
        await pause();
        // wait for the button to actually enable rather than trusting the pause to have been long
        // enough - otherwise a 0 delay would race React and abort the run
        let edit;
        try {
          edit = await waitEl(() => [...document.querySelectorAll('button')]
            .find(b => /Edit selected/i.test(b.textContent || '') && !/\bdisabled\b/.test((b.className || '').toString())) || null, 6000);
        } catch (e) { return stopDelete('"Edit selected" never became available'); }
        edit.click();
        let trash;
        try { trash = await waitEl(() => document.querySelector('button.delete'), 8000); }
        catch (e) { return stopDelete('the edit dialog did not open'); }
        const rowsBefore = listRowCount();
        await pause();                                             // beat before the destructive click
        trash.click();
        await sleep(400);                                          // fixed: let a confirm step appear if there is one
        // if this build asks to confirm, accept it (the trash icon has no text, so it can't self-match)
        const yes = [...document.querySelectorAll('button')].find(b => /^\s*(yes|ok|delete|confirm)\s*$/i.test(b.textContent || ''));
        if (yes && document.querySelector('button.delete')) yes.click();
        // Like create, the dialog may well stay open, so rows disappearing from the list is the real
        // proof - accept either that or the dialog closing, whichever happens first.
        try { await waitEl(() => (listRowCount() < rowsBefore || !document.querySelector('button.delete')) ? true : null, 9000); }
        catch (e) { return stopDelete('nothing was removed in ' + (v.name || 'this village') + ' - the route list did not change'); }
        const closeBtn = [...document.querySelectorAll('button')].find(b => /^\s*Cancel\s*$/i.test(b.textContent || ''));
        if (closeBtn && document.querySelector('button.delete')) closeBtn.click();
        await sleep(300);
        const s = applyState(); if (s.del) { s.del.removed = (s.del.removed || 0) + 1; setApplyState(s); }
        toast('🗑 ' + ((applyState().del || {}).removed || 0) + ' deleted…', '#f0a92b');
        renderApplyPanel();
        await pause();
      }
    }
    /* ----- targeted delete: remove ONE route (the village on screen -> a named destination) -----
       Backs the changeset ops: "delete" retires a route the plan dropped, and "update" removes the old
       one before re-creating it, because the game offers no edit-the-amounts flow and creating over an
       existing route only stacks another schedule onto it. */
    const normName = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    // Each route on the tab owns one group checkbox (its "Resource" header row). Climb from the box
    // until an ancestor names the destination, so a checkbox can be tied to the village it feeds.
    function routeGroups() {
      return [...document.querySelectorAll('input[type=checkbox]')]
        .filter(c => c.offsetParent && !c.name && !c.closest('#tcApplyPanel'))
        .map(c => {
          const row = c.closest('tr,div');
          if (!row || !/^Resource\b/.test((row.innerText || '').trim())) return null;
          let el = c, dest = '';
          for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
            const m = (el.innerText || '').match(/To:\s*([^\n]+)/);
            if (m) { dest = m[1].replace(/Travel.*/i, '').replace(/\s+/g, ' ').trim(); break; }
          }
          return dest ? { cb: c, dest: dest } : null;
        }).filter(Boolean);
    }
    // 'ok' removed · 'missing' no such route here (already gone - not an error) · 'fail' it would not go.
    async function deleteRouteTo(toName) {
      const want = normName(toName);
      const g = routeGroups().find(x => normName(x.dest) === want);
      if (!g) return 'missing';
      if (!g.cb.checked) g.cb.click();
      await pause();
      let edit;
      try {
        edit = await waitEl(() => [...document.querySelectorAll('button')]
          .find(b => /Edit selected/i.test(b.textContent || '') && !/\bdisabled\b/.test((b.className || '').toString())) || null, 6000);
      } catch (e) { return 'fail'; }
      edit.click();
      let trash;
      try { trash = await waitEl(() => document.querySelector('button.delete'), 8000); } catch (e) { return 'fail'; }
      const rowsBefore = listRowCount();
      await pause();                                             // beat before the destructive click
      const t0 = Date.now();
      trash.click();
      await sleep(400);                                          // let a confirm step appear if there is one
      const yes = [...document.querySelectorAll('button')].find(b => /^\s*(yes|ok|delete|confirm)\s*$/i.test(b.textContent || ''));
      if (yes && document.querySelector('button.delete')) yes.click();
      // the game's own DELETE is the proof; fall back to the list shrinking only if the hook isn't there
      let ok = await confirmedByGame('DELETE', t0);
      if (!ok && !netSeen.any) ok = await waitEl(() => listRowCount() < rowsBefore ? true : null, 9000).then(() => true, () => false);
      const closeBtn = [...document.querySelectorAll('button')].find(b => /^\s*Cancel\s*$/i.test(b.textContent || ''));
      if (closeBtn && document.querySelector('button.delete')) closeBtn.click();
      await sleep(300);
      return ok ? 'ok' : 'fail';
    }
    async function deleteLoop() {
      if (delBusy) return;
      delBusy = true;
      try {
        for (;;) {
          const s0 = applyState(); if (!s0.del || !s0.del.on) return;
          const list = s0.del.dids || [];
          if (s0.del.i >= list.length) return stopDelete(null, true);
          const v = list[s0.del.i];
          if (s0.del.curDid !== v.id) {                            // hop to the next village (page reload)
            const s = applyState(); s.del.curDid = v.id; setApplyState(s);
            await sleep(Math.max(200, stepMs()));   // floor: let the async storage write land before unload
            location.href = '/build.php?gid=17&t=3&newdid=' + v.id;
            return;                                                // the boot resume continues after load
          }
          if (!await deleteHere(v)) return;                        // stopped or failed - message already shown
          const s2 = applyState(); if (!s2.del) return;
          s2.del.i++; setApplyState(s2);
        }
      } finally { delBusy = false; }
    }

    // Start one route: jump to its source village's Trade-routes tab; resumeApply() finishes after load.
    function startPrefill(rid) {
      const plan = GM_getValue(APPLY_KEY, null); if (!plan) return;
      const route = (plan.routes || []).find(r => r.id === rid); if (!route) return;
      const st = applyState(); st.pending = { rid: rid }; setApplyState(st);
      // In the extension the store write is async (chrome.storage); navigating instantly can abort it
      // and the pending step would be lost, so let it flush before leaving the page.
      setTimeout(() => { location.href = '/build.php?gid=17&t=3&newdid=' + route.fromDid; }, 200);
    }

    // After the page (re)loads on the source village, finish a pending prefill (one-shot, can't loop).
    async function resumeApply() {
      const plan = GM_getValue(APPLY_KEY, null), st = applyState();
      if (!plan || !st || !st.pending) return;
      const auto = !!st.pending.auto;
      const route = (plan.routes || []).find(r => r.id === st.pending.rid);
      st.pending = null; setApplyState(st);
      if (!route || !/gid=17/.test(location.href)) return;
      if (auto) { if (await applyOne(route)) autoLoop(); return; }   // batch: apply it, then carry on
      // Manual, one row at a time: a delete is done outright (you pressed Delete on that row), while a
      // create/replace stops at the filled form for you to review and press Create yourself.
      const op = route.op || 'create';
      try {
        if (op === 'delete' || op === 'update') {
          const res = await deleteRouteTo(route.toName);
          if (res === 'fail') { toast('Could not delete ' + route.fromName + ' → ' + route.toName + ' - do it by hand, then mark the row ✓', '#f0533f'); return; }
          if (op === 'delete') {
            const s = applyState();
            (s.done = s.done || {})[route.id] = true;
            if (res === 'missing') (s.skipped = s.skipped || {})[route.id] = true;
            setApplyState(s);
            toast(res === 'missing' ? '= ' + route.fromName + ' has no route to ' + route.toName + ' - nothing to delete'
                                    : '🗑 Deleted ' + route.fromName + ' → ' + route.toName, res === 'missing' ? '#8b9aa8' : '#3fb950');
            renderApplyPanel();
            return;
          }
          await pause();
        }
        await prefillHere(route);
      } catch (e) { toast('Could not apply: ' + e.message, '#f0533f'); }
    }

    function renderApplyPanel() {
      const plan = GM_getValue(APPLY_KEY, null), st = applyState();
      let panel = document.getElementById('tcApplyPanel');
      if (!plan || !plan.routes || !plan.routes.length || (plan.ts || 0) <= (st.dismissed || 0)) { if (panel) panel.remove(); return; }
      if (!panel) { panel = document.createElement('div'); panel.id = 'tcApplyPanel'; document.body.appendChild(panel); }
      panel.style.cssText = 'position:fixed;bottom:56px;right:14px;z-index:2147483646;width:332px;max-height:64vh;overflow:auto;background:#171e26;color:#e6edf3;border:1px solid #2a3744;border-radius:10px;padding:10px 12px;font:12px/1.45 -apple-system,Segoe UI,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)';
      // restore a dragged position (cssText above resets to the default corner each render)
      const savedPos = applyState().panelPos;
      if (savedPos && typeof savedPos.x === 'number') {
        const p = clampPos(savedPos.x, savedPos.y, panel);
        panel.style.left = p[0] + 'px'; panel.style.top = p[1] + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
      }
      const done = st.done || {};
      // Group by SOURCE village and order naturally ("01 GAL" < "02 ROM" < "20 ROM" - numeric-aware, so
      // it matches the game's village list), destination as the tiebreak. Pre-fill jumps to the source
      // village, so keeping its routes together means fewer village switches while working down the list.
      const ordered = orderRoutes(plan.routes);
      let lastFrom = null;
      const skipped = st.skipped || {};
      // A plan is a CHANGESET: each row is one op. create = make it, replace = delete the old one then
      // re-create it (the game has no edit-amounts flow), delete = retire it.
      const OPS = { create: { m: '+', c: '#3fb950', b: 'Pre-fill ▸' },
                    update: { m: '~', c: '#f5b342', b: 'Replace ▸' },
                    'delete': { m: '−', c: '#f0805f', b: 'Delete ▸' } };
      const opOf = r => OPS[r.op || 'create'] || OPS.create;
      const rows = ordered.map(r => {
        const dn = !!done[r.id], op = r.op || 'create', o = opOf(r);
        const res = [['\u{1FAB5}', r.res.lumber], ['\u{1F9F1}', r.res.clay], ['⛏', r.res.iron], ['\u{1F33E}', r.res.crop]].filter(x => x[1] > 0).map(x => x[0] + nfmt(x[1])).join(' ');
        let head = '';
        if (r.fromName !== lastFrom) {
          lastFrom = r.fromName;
          const n = ordered.filter(x => x.fromName === r.fromName).length;
          head = '<div style="margin-top:7px;padding-top:6px;border-top:1px solid #2a3744;color:#f5b342;font-weight:600">\u{1F69A} ' + escH(r.fromName) +
                 ' <span style="color:#5d6b78;font-weight:400">' + n + ' route' + (n > 1 ? 's' : '') + '</span></div>';
        }
        const detail = op === 'delete'
          ? '<span style="color:#f0805f">remove this route</span>'
          : '<span style="color:#8b9aa8">' + res + ' · every ' + snapIv(r.interval) + 'h' + (r.useShips ? ' · ⛵' : '') + (op === 'update' ? ' <span style="color:#f5b342">(replaces the current one)</span>' : '') + '</span>';
        return head + '<div style="display:flex;gap:6px;align-items:center;padding:4px 0 4px 8px;' + (dn ? 'opacity:.45' : '') + '">' +
          '<div style="flex:1;min-width:0"><span style="color:' + o.c + ';font-weight:700" title="' + op + '">' + o.m + '</span> <b>' + escH(r.toName) + '</b><br>' + detail + '</div>' +
          (dn ? (skipped[r.id]
                ? '<span style="color:#8b9aa8" title="' + (op === 'delete' ? 'there was no such route here - nothing to delete' : 'this village already had a route to that destination, so it was left alone') + '">= ' + (op === 'delete' ? 'none' : 'exists') + '</span>'
                : '<span style="color:#3fb950;font-size:15px" title="applied by the panel">✓</span>')
              : '<button data-rid="' + escH(r.id) + '" class="tcPre" style="cursor:pointer;background:#1d2630;color:' + o.c + ';border:1px solid #2a3744;border-radius:6px;padding:4px 8px;font:inherit;white-space:nowrap">' + o.b + '</button>' +
                '<button data-rid="' + escH(r.id) + '" class="tcDone" title="mark as done / skip" style="cursor:pointer;background:transparent;color:#8b9aa8;border:1px solid #2a3744;border-radius:6px;padding:4px 7px;font:inherit">✓</button>') +
          '</div>';
      }).join('');
      const dcount = ordered.filter(r => done[r.id]).length;
      panel.innerHTML = '<div id="tcApplyHead" title="drag to move · double-click to snap back to the corner" style="display:flex;align-items:center;gap:6px;margin-bottom:4px;cursor:move;user-select:none"><span style="color:#5d6b78">⠿</span><b style="color:#f5b342">⚡ Apply changes</b><span style="color:#8b9aa8">' + dcount + '/' + plan.routes.length + '</span><span style="flex:1"></span><button id="tcApplyReset" title="reset progress" style="cursor:pointer;background:transparent;color:#8b9aa8;border:none;font:inherit">reset</button><button id="tcApplyClose" title="dismiss this plan" style="cursor:pointer;background:transparent;color:#8b9aa8;border:none;font-size:17px;line-height:1">×</button></div>' +
        '<div style="color:#8b9aa8;margin-bottom:2px">Only the <b>differences</b> from your plan: <span style="color:#3fb950">+</span> create, <span style="color:#f5b342">~</span> replace, <span style="color:#f0805f">−</span> delete. Create/replace stop at the <b>pre-filled</b> form for you to press <b>Create trade route</b>; deletes are done for you.</div>' +
        '<div style="color:#8b9aa8;margin:4px 0 1px;display:flex;align-items:center;gap:5px;flex-wrap:wrap" title="A random pause drawn from this range before every step - each field while filling, and each click while creating or deleting. Set both to 0 to run at full speed.">step delay ' +
          '<input id="tcStepMin" type="number" min="0" step="50" value="' + stepRange()[0] + '" style="width:56px;background:#1d2630;color:#e6edf3;border:1px solid #2a3744;border-radius:5px;padding:2px 4px;font:inherit">' +
          '<span>–</span>' +
          '<input id="tcStepMax" type="number" min="0" step="50" value="' + stepRange()[1] + '" style="width:56px;background:#1d2630;color:#e6edf3;border:1px solid #2a3744;border-radius:5px;padding:2px 4px;font:inherit">' +
          '<span>ms, random per step</span></div>' +
        (function () {
          const left = ordered.filter(r => !done[r.id]).length;
          const stopBtn = (id, label) => '<div style="margin:6px 0 2px;display:flex;align-items:center;gap:7px">' +
            '<button id="' + id + '" style="cursor:pointer;background:#3a1d1d;color:#f0533f;border:1px solid #f0533f;border-radius:6px;padding:4px 10px;font:inherit;font-weight:600">■ Stop</button>' +
            '<span style="color:#f0a92b">' + label + '</span></div>';
          if (st.auto && st.auto.on) return stopBtn('tcAutoStop', 'applying changes automatically…');
          if (st.del && st.del.on) return stopBtn('tcDelStop', 'deleting routes… (' + (st.del.removed || 0) + ' so far)');
          const btn = (id, bg, fg, br, label, tip, off) =>
            '<button id="' + id + '"' + (off ? ' disabled' : '') + ' title="' + tip + '" style="cursor:' + (off ? 'not-allowed' : 'pointer') +
            ';background:' + bg + ';color:' + (off ? '#5d6b78' : fg) + ';border:1px solid ' + br + ';border-radius:6px;padding:4px 10px;font:inherit;font-weight:600">' + label + '</button>';
          return '<div style="margin:6px 0 2px">' +
              btn('tcAutoAll', '#1d2630', '#f5b342', '#2a3744', '▶ Apply all ' + left + ' remaining',
                  'Work through every remaining change: delete what the plan dropped, replace what changed, submit each new route. This presses Create and the trash button for you.', !left) +
            '</div>' +
            '<div style="margin:4px 0 2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
              '<span style="color:#5d6b78">delete existing:</span>' +
              btn('tcDelHere', '#241a1a', '#f0805f', '#5a2f2f', '🗑 this village',
                  'Delete every trade route in the village you are viewing right now.') +
              btn('tcDelAll', '#241a1a', '#f0805f', '#5a2f2f', '🗑 all villages',
                  'Visit every village and delete every trade route it has. Cannot be undone from here.') +
            '</div>';
        })() + rows;
      panel.querySelector('#tcApplyClose').onclick = () => { const s = applyState(); s.dismissed = plan.ts || Date.now(); setApplyState(s); panel.remove(); };
      panel.querySelector('#tcApplyReset').onclick = () => { const s = applyState(); s.done = {}; s.skipped = {}; setApplyState(s); renderApplyPanel(); };
      // Start / stop the automatic batch. Starting is behind a confirm because, unlike Pre-fill, this
      // presses Create itself - every remaining route really will be created in game.
      const aa = panel.querySelector('#tcAutoAll');
      if (aa) aa.onclick = () => {
        const left = ordered.filter(r => !done[r.id]).length;
        if (!left) return;
        if (!confirm('Apply ' + left + ' change' + (left > 1 ? 's' : '') + ' in game automatically?\n\n' +
                     'It deletes what the plan dropped, replaces what changed, and presses Create for new routes.\n' +
                     'Deleting cannot be undone from here. It stops on the first thing the game refuses, and you can hit Stop at any time.')) return;
        const s = applyState(); s.auto = { on: true, curDid: 0 }; s.pending = null; setApplyState(s);
        renderApplyPanel(); autoLoop();
      };
      const as = panel.querySelector('#tcAutoStop');
      if (as) as.onclick = () => { const s = applyState(); s.auto = null; s.pending = null; setApplyState(s); renderApplyPanel(); toast('Stopped - nothing further will be applied.', '#f0a92b'); };
      // Deleting existing routes. Destructive and not undoable from here, so both paths confirm, and
      // the all-villages one confirms again once it knows how many villages it would walk.
      const dh = panel.querySelector('#tcDelHere');
      if (dh) dh.onclick = () => {
        if (!confirm('Delete EVERY trade route in the village you are viewing right now?\n\nThis cannot be undone from here. Pull & Sync first if you want a record of them.')) return;
        const s = applyState(); s.del = { on: true, dids: [{ id: null, name: 'this village' }], i: 0, removed: 0, curDid: null }; setApplyState(s);
        renderApplyPanel(); deleteLoop();
      };
      const da = panel.querySelector('#tcDelAll');
      if (da) da.onclick = async () => {
        if (!confirm('Delete EVERY trade route in ALL of your villages?\n\nThe script will visit each village and remove every route it finds.\nThis cannot be undone from here. Pull & Sync first if you want a record of them.')) return;
        let list;
        try { list = await villageDids(); } catch (e) { alert('Could not read your village list: ' + e.message); return; }
        if (!list.length) { alert('No villages found.'); return; }
        if (!confirm('Found ' + list.length + ' villages.\n\nProceed and delete every trade route in all of them?')) return;
        const s = applyState(); s.del = { on: true, dids: list, i: 0, removed: 0, curDid: 0 }; setApplyState(s);
        renderApplyPanel(); deleteLoop();
      };
      const ds = panel.querySelector('#tcDelStop');
      if (ds) ds.onclick = () => { const s = applyState(); s.del = null; setApplyState(s); renderApplyPanel(); toast('Stopped - nothing further will be deleted.', '#f0a92b'); };
      // Drag the panel by its header. Position is stored, so it stays put across the page reloads
      // that Pre-fill triggers; double-clicking the header forgets it and snaps back to the corner.
      const head = panel.querySelector('#tcApplyHead');
      if (head) {
        head.onmousedown = ev => {
          if (ev.button !== 0 || (ev.target.closest && ev.target.closest('button,input,select'))) return;
          ev.preventDefault();
          const r = panel.getBoundingClientRect(), dx = ev.clientX - r.left, dy = ev.clientY - r.top;
          panel.style.right = 'auto'; panel.style.bottom = 'auto';
          const move = e => { const p = clampPos(e.clientX - dx, e.clientY - dy, panel); panel.style.left = p[0] + 'px'; panel.style.top = p[1] + 'px'; };
          const up = () => {
            document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
            const rr = panel.getBoundingClientRect(), s = applyState();
            s.panelPos = { x: Math.round(rr.left), y: Math.round(rr.top) }; setApplyState(s);
          };
          document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
        };
        head.ondblclick = ev => {
          if (ev.target.closest && ev.target.closest('button,input,select')) return;
          const s = applyState(); delete s.panelPos; setApplyState(s); renderApplyPanel();
        };
      }
      // save on change only (not re-render), so typing in the boxes doesn't steal focus mid-edit
      const mn = panel.querySelector('#tcStepMin'), mx = panel.querySelector('#tcStepMax');
      const saveRange = () => { const s = applyState(); s.stepMin = Math.max(0, +mn.value || 0); s.stepMax = Math.max(0, +mx.value || 0); delete s.stepMs; setApplyState(s); };
      if (mn) mn.onchange = saveRange;
      if (mx) mx.onchange = saveRange;
      // Row action. A create just pre-fills the form, but a delete/replace removes a live route, so
      // those confirm first - the panel never deletes anything off a single stray click.
      panel.querySelectorAll('.tcPre').forEach(b => b.onclick = () => {
        const rid = b.getAttribute('data-rid');
        const r = (plan.routes || []).find(x => x.id === rid), op = (r && r.op) || 'create';
        if (op === 'delete' && !confirm('Delete the route ' + r.fromName + ' → ' + r.toName + ' in game?\n\nThis cannot be undone from here.')) return;
        if (op === 'update' && !confirm('Replace the route ' + r.fromName + ' → ' + r.toName + '?\n\nThe existing route is DELETED first (the game has no edit-amounts flow), then the create form opens pre-filled with the new amounts for you to confirm.')) return;
        startPrefill(rid);
      });
      panel.querySelectorAll('.tcDone').forEach(b => b.onclick = () => { const s = applyState(); (s.done = s.done || {})[b.getAttribute('data-rid')] = true; setApplyState(s); renderApplyPanel(); });
    }

    // Version marker on <html>, so you can tell at a glance which build is actually live:
    // reloading an unpacked extension is what re-reads content.js - extension PAGES (dashboard/tool)
    // are re-read from disk on every load, so the dashboard can be new while this script is still old.
    // Check in the game tab's console: document.documentElement.dataset.tcVersion
    try { document.documentElement.setAttribute('data-tc-version', '1.12.0'); } catch (e) {}
    addButton();
    // Under Tampermonkey GM_getValue is synchronous so this runs at once; in the extension the GM shim
    // is backed by (async) chrome.storage, so defer until the first read has landed - otherwise the
    // panel and the resume-after-navigation step would both read an empty store.
    const whenStore = fn => { try { if (typeof __tcWhenReady === 'function') return __tcWhenReady(fn); } catch (e) {} fn(); };
    whenStore(async () => {
      renderApplyPanel();
      const hadPending = !!applyState().pending;
      await resumeApply();                                   // a pending step also continues the batch itself
      if (!hadPending) {                                   // resume a run cut short by a reload / village hop
        const s = applyState();
        if (s.auto && s.auto.on) autoLoop();
        else if (s.del && s.del.on) deleteLoop();
      }
    });
    // a fresh plan pushed from the tool: reset progress and show the panel
    try { GM_addValueChangeListener(APPLY_KEY, (n, o, nv) => { const k = applyState(); setApplyState({ ts: (nv && nv.ts) || Date.now(), done: {}, pending: null, dismissed: 0, stepMin: k.stepMin, stepMax: k.stepMax, panelPos: k.panelPos }); renderApplyPanel(); }); } catch (e) {}
    try { GM_registerMenuCommand('Pull & Sync now', () => run(document.getElementById('tcPullSync'))); } catch (e) {}
  }

  /* =======================================================================
     TOOL SIDE - receive pushed data and import it silently
     ======================================================================= */
  if (isTool) {
    let lastTs = 0;

    // Expose a hook the tool calls to push a plan of routes to create in-game. It lands in GM storage;
    // the game tab's "Apply routes" panel picks it up. Semi-auto: the game only ever pre-fills the form.
    try {
      (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).tcApplyRoutes = plan => {
        try {
          GM_setValue('tc_apply', { ts: Date.now(), account: (plan && plan.account) || null, routes: (plan && plan.routes) || [] });
          toast('✓ Sent ' + (((plan && plan.routes) || []).length) + ' route(s) to your game tab — open it and use the ⚡ Apply routes panel.', '#3fb950');
          return true;
        } catch (e) { return false; }
      };
    } catch (e) {}

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
