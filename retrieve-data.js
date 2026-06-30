/* ============================================================================
   Travian Resource Commander - data retriever  (read-only, no game actions)
   ----------------------------------------------------------------------------
   Pulls every village's: tribe, marketplace level, Trade Office level, barracks &
   stable levels, resource production, net crop, and computes real per-merchant
   capacity. Downloads
   "travian-carrier-data.json" to Import / Sync into the tool.

   RUN: log into your game world -> F12 Console -> paste this whole file -> Enter.
   (Or click "Pull from game" in the tool, which copies this for you.)

   Capacity is CALCULATED (no slow page loads):
     capacity = base[tribe] * serverSpeed * (1 + TOrate*TOlevel/100) * (1 + alliance/100)
   Calibrated against real RoF x2 values. If your alliance commerce bonus changes,
   edit ALLIANCE_BONUS below.
   ============================================================================ */
(async function () {
  'use strict';
  // ===================== calibration (edit if needed) =======================
  const ALLIANCE_BONUS = 90;                                   // % merchant-capacity bonus (0 = none)
  const SERVER = (+(location.host.match(/\bx(\d+)\b/) || [])[1]) || 1;   // x2 -> 2, etc.
  const TRIBE = {  // base merchant capacity + Trade-Office %/level, keyed by wall class
    gaul:     { name: 'Gauls',     base: 750,  toRate: 20 },
    roman:    { name: 'Romans',    base: 500,  toRate: 40 },
    teuton:   { name: 'Teutons',   base: 1000, toRate: 20 },
    egyptian: { name: 'Egyptians', base: 750,  toRate: 20 },
    hun:      { name: 'Huns',      base: 500,  toRate: 20 },
    spartan:  { name: 'Spartans',  base: 500,  toRate: 20 }
  };
  const TID = { 1: 'roman', 2: 'teuton', 3: 'gaul', 6: 'egyptian', 7: 'hun', 8: 'spartan' }; // Travian tribeId -> wall class
  // ==========================================================================
  const STRIP = /[‪-‮⁦-⁩]/g;
  const clean = s => String(s == null ? '' : s).replace(STRIP, '').replace(/\s+/g, ' ').trim();
  const getText = u => fetch(u, { credentials: 'same-origin' }).then(r => r.text());
  const title = h => { const d = new DOMParser().parseFromString(h, 'text/html'); return clean((d.querySelector('.titleInHeader, h1') || {}).textContent); };
  const lvl = (h, label) => { const t = title(h); if (label && !new RegExp(label, 'i').test(t)) return 0; const m = t.match(/Level\s*(\d+)/i); return m ? +m[1] : 0; };
  const log = (...a) => console.log('%c[retrieve]', 'color:#f5b342', ...a);
  // Per-trade-ship cargo is per-village state (not a clean formula) and is only on the
  // React-rendered marketplace send tab, so read it in a hidden iframe (only when ships>0).
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

  log('reading village list...');
  const root = await getText('/dorf1.php');
  const i = root.indexOf('"villageList":');
  if (i < 0) { alert('Could not read the village list - make sure you are logged into the game world.'); return; }
  let d = 0, s = root.indexOf('[', i), j = s;
  for (; j < root.length; j++) { const c = root[j]; if (c === '[') d++; else if (c === ']') { d--; if (!d) { j++; break; } } }
  const list = [];
  JSON.parse(root.slice(s, j)).forEach(e => e.villages ? e.villages.forEach(v => list.push(v)) : list.push(e));
  log('found ' + list.length + ' villages');

  const villages = [];
  for (const v of list) {
    const d1 = await getText('/dorf1.php?newdid=' + v.id);
    const pm = d1.match(/production:\s*(\{[^}]*\})/); const p = pm ? JSON.parse(pm[1]) : {};
    const mkt = lvl(await getText('/build.php?gid=17&newdid=' + v.id));
    const to  = lvl(await getText('/build.php?gid=28&newdid=' + v.id), 'Trade Office');
    const bar = lvl(await getText('/build.php?gid=19&newdid=' + v.id)); // gid 19 = Barracks
    const sta = lvl(await getText('/build.php?gid=20&newdid=' + v.id)); // gid 20 = Stable
    const d2 = await getText('/dorf2.php?newdid=' + v.id);
    const tid = +(d1.match(/"village":\s*\{[^}]*?"tribeId":\s*(\d+)/) || [])[1] || 0; // reliable even without a wall
    const wm = d2.match(/class="wall\s+([a-z]+)/i);
    const T = TRIBE[TID[tid] || (wm ? wm[1].toLowerCase() : 'roman')] || TRIBE.roman;
    const cap = Math.round(T.base * SERVER * (1 + T.toRate * to / 100) * (1 + ALLIANCE_BONUS / 100));
    // harbor (gid 49): "Trade ship (In service N)" -> N. Absent / no harbor -> 0.
    const harbor = clean(await getText('/build.php?gid=49&newdid=' + v.id));
    const sm = harbor.match(/trade ?ship[^()]*\(\s*in service\s*(\d+)/i);
    const ships = sm ? +sm[1] : 0;
    const shipCap = ships > 0 ? await readShipCap(v.id) : 0;
    const l4 = p.l4 || 0, l5 = p.l5 || 0;           // l4 = net crop, l5 = free crop
    villages.push({
      name: v.name, did: v.id, x: v.x, y: v.y, tribe: T.name, synced: true,
      prod: { lumber: p.l1 || 0, clay: p.l2 || 0, iron: p.l3 || 0, crop: l5 },
      baseConsumption: Math.max(0, l5 - l4),         // so net crop = l4
      marketplaceLevel: mkt, tradeOfficeLevel: to, merchantCapacityReal: cap,
      tradeShips: ships, shipCapacityReal: shipCap,
      barracksLevel: bar, stableLevel: sta
    });
    log(`${v.name}: ${T.name} mkt${mkt} TO${to} bar${bar} sta${sta} cap${cap} ships${ships}${shipCap?('@'+shipCap):''} net${l4}`);
  }
  if (list[0]) await getText('/dorf1.php?newdid=' + list[0].id);   // restore active village

  villages.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
  const payload = {
    source: 'travian-sync',
    note: 'retrieve-data ' + new Date().toISOString() + '; capacity computed (alliance ' + ALLIANCE_BONUS + '%, server x' + SERVER + '); prod.crop=l5, baseConsumption=l5-l4 so net crop=l4.',
    villages
  };
  const json = JSON.stringify(payload, null, 2);
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'travian-carrier-data.json';
    document.body.appendChild(a); a.click(); a.remove();
    log('%cDONE - downloaded travian-carrier-data.json (' + villages.length + ' villages). Import it into the tool.', 'color:#3fb950');
  } catch (e) { console.log(json); log('Download blocked - copy the JSON above into travian-carrier-data.json'); }
  window.travianCarrierData = payload;
  try { await navigator.clipboard.writeText(json); log('(also copied to clipboard)'); } catch (e) {}
})();
