// Runs on *.travian.com. Adds a "Pull & Sync" button that reads every village's data
// (read-only fetches) and writes it to chrome.storage.local, where the dashboard picks
// it up. Ported from the Tampermonkey bridge's game side.
(function () {
  'use strict';
  const KEY = 'tc_sync';

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
  const TID = { 1: 'roman', 2: 'teuton', 3: 'gaul', 6: 'egyptian', 7: 'hun', 8: 'spartan' };
  // ==========================================================================

  const STRIP = /[‪-‮⁦-⁩]/g;
  const clean = s => String(s == null ? '' : s).replace(STRIP, '').replace(/\s+/g, ' ').trim();
  const getText = u => fetch(u, { credentials: 'same-origin' }).then(r => r.text());
  const title = h => { const dc = new DOMParser().parseFromString(h, 'text/html'); return clean((dc.querySelector('.titleInHeader, h1') || {}).textContent); };
  const lvl = (h, label) => { const t = title(h); if (label && !new RegExp(label, 'i').test(t)) return 0; const m = t.match(/Level\s*(\d+)/i); return m ? +m[1] : 0; };
  const SERVER = (+(location.host.match(/\bx(\d+)\b/) || [])[1]) || 1;

  function toast(msg, color) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:64px;right:14px;z-index:2147483647;background:#171e26;color:' +
      (color || '#e6edf3') + ';border:1px solid #2a3744;border-radius:8px;padding:8px 12px;' +
      'font:12px/1.4 -apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);max-width:280px';
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 3500);
  }

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

  // Extract a balanced [...] array from `str` at/after `from`, skipping JSON strings.
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

  // Active recurring trade routes from the marketplace "Trade routes" tab (t=3) JSON.
  function extractTradeRoutes(html) {
    const raw = sliceArray(html, html.indexOf('"tradeRoutes":'));
    if (!raw) return [];
    let arr; try { arr = JSON.parse(raw); } catch (e) { return []; }
    const out = [], keys = ['lumber', 'clay', 'iron', 'crop'];
    arr.forEach(tr => {
      if (!tr || !tr.from || !tr.to || !Array.isArray(tr.routes)) return;
      const sends = tr.routes.filter(r => r && r.enabled).sort((a, b) => (a.departureAt || 0) - (b.departureAt || 0));
      if (!sends.length) return;
      const per = { lumber: 0, clay: 0, iron: 0, crop: 0 }; let merch = 0;
      sends.forEach(r => { const cr = r.carriedResources || {}; keys.forEach(k => per[k] += cr[k] || 0); if ((r.merchants || 0) > merch) merch = r.merchants || 0; });
      keys.forEach(k => per[k] = Math.round(per[k] / sends.length));
      if (!keys.some(k => per[k])) return;
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

  // Balanced {...} slice from `str` at/after `from`, string-aware.
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

  // Per-resource production boost ACTUALLY applied right now, from production.php's
  // ProductionOverview viewData. productionBoostFactor is the configured boost (set on every
  // resource even when inactive); the real applied boost is balanceSheet - interimBalanceSheet,
  // which is 0 for a resource whose ad/Gold boost has lapsed - detected independently per resource.
  function extractBoost(html) {
    const idx = html.indexOf('ProductionOverview.render(');
    if (idx < 0) return null;
    const raw = sliceObject(html, idx);
    if (!raw) return null;
    let obj; try { obj = JSON.parse(raw); } catch (e) { return null; }
    const vd = obj && obj.viewData; if (!vd) return null;
    const pct = {}, amt = {};
    ['lumber', 'clay', 'iron', 'crop'].forEach(k => {
      const r = vd[k] || {};
      const base = +r.interimBalanceSheet || 0, now = +r.balanceSheet || 0, a = Math.max(0, now - base);
      amt[k] = a;
      pct[k] = (a > 0 && base > 0) ? Math.round((now / base - 1) * 100) : 0;
    });
    return { pct, amt };
  }

  // Trainable units from a Barracks/Stable/Workshop page: real per-server cost + training time.
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

    let player = clean((root.match(/class="playerName"[^>]*>\s*([^<]+?)\s*</) || [])[1] || (root.match(/"ownPlayer":\s*\{[^}]*?"name":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
    const serverName = clean((root.match(/<title>([^<]*)<\/title>/i) || [])[1] || '');
    let playerId = 0;

    const villages = [], routes = [];
    for (let n = 0; n < list.length; n++) {
      const v = list[n];
      if (onProgress) onProgress(n + 1, list.length);
      // production.php is a superset of dorf1.php (same `var resources`, tribeId) PLUS the
      // per-resource production-boost breakdown - one fetch, no extra request.
      const d1 = await getText('/production.php?t=lumber&newdid=' + v.id);
      const pm = d1.match(/production:\s*(\{[^}]*\})/); const p = pm ? JSON.parse(pm[1]) : {};
      const boost = extractBoost(d1);
      const stm = d1.match(/storage:\s*(\{[^}]*\})/);    const st = stm ? JSON.parse(stm[1]) : {};
      const mxm = d1.match(/maxStorage:\s*(\{[^}]*\})/); const mx = mxm ? JSON.parse(mxm[1]) : {};
      const stock = k => Math.max(0, Math.round(+st['l' + k] || 0));
      const capOf = k => Math.max(0, Math.round(+mx['l' + k] || 0));
      const mkt = lvl(await getText('/build.php?gid=17&newdid=' + v.id));
      const to = lvl(await getText('/build.php?gid=28&newdid=' + v.id), 'Trade Office');
      const barHtml = await getText('/build.php?gid=19&newdid=' + v.id), bar = lvl(barHtml);
      const staHtml = await getText('/build.php?gid=20&newdid=' + v.id), sta = lvl(staHtml);
      const wspHtml = await getText('/build.php?gid=21&newdid=' + v.id), wsp = lvl(wspHtml);
      const trainable = parseUnits(barHtml, 'barracks').concat(parseUnits(staHtml, 'stable'), parseUnits(wspHtml, 'workshop'));
      const twn = lvl(await getText('/build.php?gid=24&newdid=' + v.id));
      const d2 = await getText('/dorf2.php?newdid=' + v.id);
      const tid = +(d1.match(/"village":\s*\{[^}]*?"tribeId":\s*(\d+)/) || [])[1] || 0;
      const wm = d2.match(/class="wall\s+([a-z]+)/i);
      const T = TRIBE[TID[tid] || (wm ? wm[1].toLowerCase() : 'roman')] || TRIBE.roman;
      const cap = Math.round(T.base * SERVER * (1 + T.toRate * to / 100) * (1 + ALLIANCE_BONUS / 100));
      const harbor = clean(await getText('/build.php?gid=49&newdid=' + v.id));
      const sm = harbor.match(/trade ?ship[^()]*\(\s*in service\s*(\d+)/i);
      const ships = sm ? +sm[1] : 0;
      const shipCap = ships > 0 ? await readShipCap(v.id) : 0;
      const l4 = p.l4 || 0, l5 = p.l5 || 0;
      villages.push({
        name: v.name, did: v.id, x: v.x, y: v.y, tribe: T.name, synced: true,
        prod: { lumber: p.l1 || 0, clay: p.l2 || 0, iron: p.l3 || 0, crop: l5 },
        prodBoostPct: boost ? boost.pct : { lumber: 0, clay: 0, iron: 0, crop: 0 },
        prodBoost: boost ? boost.amt : { lumber: 0, clay: 0, iron: 0, crop: 0 },
        baseConsumption: Math.max(0, l5 - l4),
        warehouse: { capacity: capOf(1), lumber: stock(1), clay: stock(2), iron: stock(3) },
        granary: { capacity: capOf(4), crop: stock(4) },
        marketplaceLevel: mkt, tradeOfficeLevel: to, merchantCapacityReal: cap,
        tradeShips: ships, shipCapacityReal: shipCap,
        barracksLevel: bar, stableLevel: sta, workshopLevel: wsp, townHallLevel: twn, trainable
      });
      const rtHtml = await getText('/build.php?gid=17&t=3&newdid=' + v.id);
      if (!playerId) { const m = rtHtml.match(/"ownPlayer":\s*\{\s*"id":\s*(\d+)/); if (m) playerId = +m[1]; }
      if (!player) { const m = rtHtml.match(/class="playerName"[^>]*>\s*([^<]+?)\s*</); if (m) player = clean(m[1]); }
      extractTradeRoutes(rtHtml).forEach(r => routes.push(r));
    }
    const account = { server: location.host, serverName, player, playerId };
    if (list[0]) await getText('/dorf1.php?newdid=' + list[0].id);
    villages.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
    return { villages, routes, account };
  }

  async function run(btn) {
    const label = btn ? btn.textContent : '';
    try {
      if (btn) btn.disabled = true;
      const { villages, routes, account } = await pullAll((i, t) => { if (btn) btn.textContent = 'Pulling ' + i + '/' + t + '...'; });
      await chrome.storage.local.set({ [KEY]: { ts: Date.now(), source: 'travian-sync', villages, routes, account } });
      toast('✓ ' + (account.player || account.serverName || 'account') + ': pulled ' + villages.length + ' villages, ' + routes.length + ' routes', '#3fb950');
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
    b.title = 'Retrieve all villages and push them to the Resource Commander';
    b.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;cursor:pointer;' +
      'background:#1d2630;color:#f5b342;border:1px solid #2a3744;border-radius:8px;padding:8px 12px;' +
      'font:600 12px/1.2 -apple-system,Segoe UI,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)';
    b.onclick = () => run(b);
    document.body.appendChild(b);
  }

  if (document.body) addButton();
  else document.addEventListener('DOMContentLoaded', addButton);
})();
