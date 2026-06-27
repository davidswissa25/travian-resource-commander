// ==UserScript==
// @name         Travian Resource Commander - Sync (read-only)
// @namespace    travian-commander
// @version      2.3
// @description  Read-only capture of village resources/production/capacity from the new Travian interface for Travian Resource Commander. No automated game actions.
// @author       you
// @match        *://*.travian.com/*
// @match        *://*.travian.de/*
// @match        *://*.travian.fr/*
// @match        *://*.travian.ru/*
// @match        *://*.travian.us/*
// @match        *://*.travian.co.uk/*
// @match        *://*.travian.com.br/*
// @match        *://*.travian.asia/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
  READ-ONLY. Reads the in-page `resources` object Travian already loads.
  No clicks, no navigation, no server requests, no automation. Never sees your password.

  USE: Install in Tampermonkey (Dashboard > + > paste > Ctrl+S). Do NOT double-click the file.
  Log in; the panel appears bottom-right and captures each village as you view it.
  "Download" then Import / Sync into Travian Resource Commander.

  DEBUG: if capture fails, click "Dump diag" or "Copy source" and paste it back to Claude.
*/

(function () {
  'use strict';
  var STORE_KEY = 'travianCommanderSyncStore';
  var TRIBES = {
    Romans:{merchantCapacity:500,merchantSpeed:16}, Gauls:{merchantCapacity:750,merchantSpeed:24},
    Teutons:{merchantCapacity:1000,merchantSpeed:12}, Egyptians:{merchantCapacity:750,merchantSpeed:16},
    Huns:{merchantCapacity:500,merchantSpeed:20}, Spartans:{merchantCapacity:400,merchantSpeed:16}
  };

  // strip bidi/format marks and normalise unicode minus
  function clean(s){ return String(s==null?'':s).replace(/[‪-‮⁦-⁩‎‏؜]/g,'').replace(/−/g,'-'); }
  function toInt(s){ var m = clean(s).replace(/[^\d\-]/g,''); var n = parseInt(m,10); return isNaN(n)?0:n; }
  function q(sel){ try { return document.querySelector(sel); } catch(e){ return null; } }
  function loadStore(){ try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch(e){ return {}; } }
  function saveStore(s){ localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function status(html){ var e=q('#tcStatus'); if(e) e.innerHTML=html; }

  function readResourcesObj(){
    var r = (typeof window.resources==='object'&&window.resources) ? window.resources
          : (window.Travian&&window.Travian.Game&&window.Travian.Game.resources) ? window.Travian.Game.resources : null;
    if (!r) return null;
    function num(x){ return x==null?0:(+x||0); }
    function pick(o){ return o ? {l1:num(o.l1),l2:num(o.l2),l3:num(o.l3),l4:num(o.l4),l5:num(o.l5)} : null; }
    return { production:pick(r.production), storage:pick(r.storage), maxStorage:pick(r.maxStorage) };
  }

  function readActiveVillage(){
    var el = q('.villageList .listEntry.active') || q('.villageList .active')
          || q('#sidebarBoxActiveVillage') || q('[class*="active"][class*="village"]');
    var name='Village', x=0, y=0;
    if (el){
      var sub = el.querySelector('.name');
      var raw = clean(el.textContent).trim();
      var m = raw.match(/\(?\s*(-?\d+)\s*\|\s*(-?\d+)\s*\)?/);
      if (m){ x=+m[1]; y=+m[2]; }
      name = sub ? clean(sub.textContent).trim() : raw.split('(')[0].trim();
    } else {
      var cx=q('.coordinateX'), cy=q('.coordinateY');
      if (cx&&cy){ x=toInt(cx.textContent); y=toInt(cy.textContent); }
      name = (document.title.split(/[|–-]/)[0]||'Village').trim();
    }
    return { name:name||'Village', x:x, y:y };
  }

  function panelTribe(){ var s=q('#tcTribe'); return s?s.value:'Gauls'; }

  function capture(manual){
    var o = readResourcesObj();
    if (!o || !o.production || !o.storage){
      if (manual) status('<b style="color:#f0533f">No resource data here - open a village view, or click Dump diag.</b>');
      return null;
    }
    var p=o.production, s=o.storage, m=o.maxStorage||{};
    var av = readActiveVillage();
    var tribe = panelTribe(); var t = TRIBES[tribe]||TRIBES.Gauls;
    var cropProd = p.l5, cropUpkeep = Math.max(0, p.l5 - p.l4), netCrop = p.l4;
    var v = {
      name:av.name, tribe:tribe, x:av.x, y:av.y,
      prod:{ lumber:p.l1, clay:p.l2, iron:p.l3, crop:cropProd },
      baseConsumption:cropUpkeep, troops:[],
      warehouse:{ capacity:m.l1||0, lumber:s.l1, clay:s.l2, iron:s.l3 },
      granary:{ capacity:m.l4||0, crop:s.l4 },
      merchantCapacity:t.merchantCapacity, merchantSpeed:t.merchantSpeed,
      synced:true, _cropL4:p.l4, _cropL5:p.l5, updatedAt:Date.now()
    };
    var store = loadStore();
    store[(v.name.toLowerCase())+'@'+v.x+'|'+v.y] = v;
    saveStore(store);
    status('<b style="color:#3fb950">&#10003; '+esc(v.name)+'</b> ('+Object.keys(store).length+' total)<br>net crop '
           + (netCrop>=0?'+':'') + netCrop.toLocaleString()
           + ' &middot; troop upkeep ' + cropUpkeep.toLocaleString());
    return v;
  }

  // "HH:MM:SS" -> seconds
  function parseTimer(str){
    var m = clean(str||'').match(/(\d+):(\d{2}):(\d{2})/);
    if (!m) return 0;
    return (+m[1])*3600 + (+m[2])*60 + (+m[3]);
  }

  // Find the stored village whose name matches (case-insensitive). Returns key or null.
  function matchStoreKey(store, vname){
    vname = vname.toLowerCase();
    return Object.keys(store).find(function(k){ return k.split('@')[0] === vname; }) || null;
  }

  /* Apply one warehouse-overview row to a store entry.
     row = { name, lumber, clay, iron, crop, capWh, capGr, whSec, grSec, cropDrain }
     Any of lumber/clay/iron/crop/capWh/capGr may be null (unknown) -> falls back to
     the village's existing stored values (needed for plain-text % paste).      */
  function applyOverviewRow(store, row){
    var key = matchStoreKey(store, row.name);
    if (!key) return false;
    var v = store[key];
    var wh = v.warehouse || {}, gr = v.granary || {};

    var capWh = row.capWh != null ? row.capWh : (wh.capacity||0);
    var capGr = row.capGr != null ? row.capGr : (gr.capacity||0);

    v.warehouse = {
      capacity: capWh,
      lumber: row.lumber != null ? row.lumber : (wh.lumber||0),
      clay:   row.clay   != null ? row.clay   : (wh.clay||0),
      iron:   row.iron   != null ? row.iron   : (wh.iron||0)
    };
    var cropVal = row.crop != null ? row.crop : (gr.crop||0);
    v.granary = { capacity: capGr, crop: cropVal };

    // derive crop net rate from the granary timer (crop-only timer)
    if (row.grSec > 0){
      var perSec = row.cropDrain ? (-cropVal / row.grSec)
                                 : ((capGr - cropVal) / row.grSec);
      v._netCropPerHour = Math.round(perSec * 3600);
      v._cropDrain = !!row.cropDrain;
    }
    v.updatedAt = Date.now();
    store[key] = v;
    return true;
  }

  // Parse the warehouse <table> inside a DOM root (live page OR pasted HTML).
  function parseWarehouseDom(root){
    var tbl = (root || document).querySelector('#warehouse');
    if (!tbl) return [];
    var out = [];
    function extractVal(titleAttr){
      var t = clean(titleAttr||'');
      var m = t.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
      if (!m) return {val:null,max:null};
      return { val:parseInt(m[1].replace(/,/g,''),10), max:parseInt(m[2].replace(/,/g,''),10) };
    }
    Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function(rowEl){
      var nameEl = rowEl.querySelector('td.vil a, td.fc a');
      var lumEl  = rowEl.querySelector('td.lum');
      var clayEl = rowEl.querySelector('td.clay');
      var ironEl = rowEl.querySelector('td.iron');
      var cropEl = rowEl.querySelector('td.crop');
      if (!nameEl || !lumEl || !clayEl || !ironEl || !cropEl) return;
      var lum=extractVal(lumEl.getAttribute('title')), clay=extractVal(clayEl.getAttribute('title')),
          iron=extractVal(ironEl.getAttribute('title')), crop=extractVal(cropEl.getAttribute('title'));
      var whEl = rowEl.querySelector('td.max123 .timer');
      var grEl = rowEl.querySelector('td.max4 .timer');
      var grCell = rowEl.querySelector('td.max4');
      out.push({
        name: clean(nameEl.textContent).trim(),
        lumber:lum.val, clay:clay.val, iron:iron.val, crop:crop.val,
        capWh:lum.max, capGr:crop.max,
        whSec: whEl?parseTimer(whEl.textContent):0,
        grSec: grEl?parseTimer(grEl.textContent):0,
        cropDrain: !!(grCell && /crit|minus|&minus;|[-−]/.test(grCell.innerHTML))
      });
    });
    return out;
  }

  /* Parse plain text copied with Ctrl+A Ctrl+C from the warehouse page.
     Visible cells are percentages + timers only (no raw numbers / capacities). */
  function parseWarehouseText(text){
    var out = [];
    clean(text).split(/\r?\n/).forEach(function(line){
      if (!/%/.test(line)) return;                       // village rows always have %
      var pcts   = (line.match(/(\d+)\s*%/g) || []).map(function(s){ return parseInt(s,10); });
      var timers = line.match(/\d+:\d{2}:\d{2}/g) || [];
      if (pcts.length < 3) return;                        // need lum/clay/iron at least
      var name = line.split(/\s*\d+\s*%/)[0].replace(/\s+/g,' ').trim();
      if (!name) return;
      // crop is the 4th percentage when present
      var whSec = timers[0] ? parseTimer(timers[0]) : 0;
      var grSec = timers[1] ? parseTimer(timers[1]) : 0;
      // a minus before the granary timer => crop draining
      var afterWh = timers[0] ? line.slice(line.indexOf(timers[0]) + timers[0].length) : line;
      out.push({
        name: name,
        pctLum: pcts[0], pctClay: pcts[1], pctIron: pcts[2], pctCrop: pcts[3],
        whSec: whSec, grSec: grSec,
        cropDrain: /[-−]/.test(afterWh)
      });
    });
    return out;
  }

  // Convert a captured live page OR pasted blob into store updates. Returns count.
  function importBlob(text){
    var store = loadStore(), updated = 0;
    var looksHtml = /<\s*(table|tr|td|div|html)\b/i.test(text) || /class="(lum|clay|iron|crop|vil)"/.test(text);

    if (looksHtml){
      var doc;
      try { doc = new DOMParser().parseFromString(text, 'text/html'); } catch(e){ doc = null; }
      var rows = doc ? parseWarehouseDom(doc) : [];
      rows.forEach(function(r){ if (applyOverviewRow(store, r)) updated++; });
    } else {
      // plain text: only % + timers -> need each village's stored capacity to rebuild raw
      parseWarehouseText(text).forEach(function(r){
        var key = matchStoreKey(store, r.name);
        if (!key) return;
        var v = store[key];
        var capWh = (v.warehouse && v.warehouse.capacity) || 0;
        var capGr = (v.granary && v.granary.capacity) || 0;
        var pc = function(pct, cap){ return (pct!=null && cap) ? Math.round(pct/100*cap) : null; };
        var ok = applyOverviewRow(store, {
          name: r.name,
          lumber: pc(r.pctLum, capWh), clay: pc(r.pctClay, capWh), iron: pc(r.pctIron, capWh),
          crop: pc(r.pctCrop, capGr),
          capWh: capWh||null, capGr: capGr||null,
          whSec: r.whSec, grSec: r.grSec, cropDrain: r.cropDrain
        });
        if (ok) updated++;
      });
    }
    if (updated) saveStore(store);
    return updated;
  }

  // live page table -> store
  function captureWarehouseTable(){
    if (!q('#warehouse')) return 0;
    var store = loadStore(), updated = 0;
    parseWarehouseDom(document).forEach(function(r){ if (applyOverviewRow(store, r)) updated++; });
    if (updated) saveStore(store);
    return updated;
  }

  function exportPayload(){ return { source:'travian-sync', exportedAt:Date.now(), villages:Object.values(loadStore()) }; }

  function diagnostic(){
    var out=['=== Commander Sync diagnostic ==='];
    out.push('URL: '+location.href);
    out.push('readyState: '+document.readyState+' | panel: '+!!q('#tcSyncPanel'));
    var o=readResourcesObj();
    out.push('resources global: '+(o?JSON.stringify(o):'NONE (window.resources missing on this page)'));
    out.push('parsed active village: '+JSON.stringify(readActiveVillage()));
    var sels=['.villageList .listEntry.active','.villageList .active','#sidebarBoxActiveVillage','.villageList','[class*="village"]'];
    sels.forEach(function(sel){ var e=q(sel);
      out.push(sel+' => '+(e?('FOUND: '+e.outerHTML.replace(/\s+/g,' ').slice(0,400)):'missing')); });
    return out.join('\n');
  }

  function countLine(){ var n=Object.keys(loadStore()).length; status(n?('<b style="color:#3fb950">'+n+'</b> village'+(n>1?'s':'')+' captured'):'Open a village to capture it.'); }

  function copy(text, okMsg){
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ status('<b style="color:#3fb950">'+okMsg+'</b>'); setTimeout(countLine,2200); },
        function(){ console.log(text); status('Copy blocked - opened in console (F12)'); });
    } else { console.log(text); status('Copy unavailable - opened in console (F12)'); }
  }

  function buildPanel(){
    if (q('#tcSyncPanel')) return;
    var p=document.createElement('div');
    p.id='tcSyncPanel';
    p.style.cssText='position:fixed;bottom:14px;right:14px;z-index:2147483647;background:#171e26;color:#e6edf3;border:1px solid #2a3744;border-radius:10px;font:12px/1.4 -apple-system,Segoe UI,sans-serif;padding:10px 12px;width:250px;box-shadow:0 6px 24px rgba(0,0,0,.4)';
    var h='';
    h+='<div style="font-weight:700;color:#f5b342;margin-bottom:6px">Commander Sync</div>';
    h+='<div id="tcStatus" style="margin-bottom:8px;color:#8b9aa8">Loading...</div>';
    h+='<label style="display:block;margin-bottom:6px;color:#8b9aa8">Tribe (applies to captures)';
    h+='<select id="tcTribe" style="width:100%;margin-top:2px;background:#0f1419;color:#e6edf3;border:1px solid #2a3744;border-radius:5px;padding:4px">';
    h+='<option>Gauls</option><option>Romans</option><option>Teutons</option><option>Egyptians</option><option>Huns</option><option>Spartans</option></select></label>';
    h+='<div style="display:flex;gap:5px;flex-wrap:wrap">';
    h+='<button id="tcCap" style="flex:1">Capture</button><button id="tcDl" style="flex:1">Download</button>';
    h+='<button id="tcCopy" style="flex:1">Copy</button><button id="tcClear" style="flex:1">Clear</button></div>';
    h+='<div style="display:flex;gap:5px;margin-top:5px">';
    h+='<button id="tcDump" style="flex:1">Dump diag</button><button id="tcSrc" style="flex:1">Copy source</button></div>';
    h+='<div style="display:flex;gap:5px;margin-top:5px">';
    h+='<button id="tcPasteToggle" style="flex:1">Paste import &#9662;</button></div>';
    h+='<div id="tcPasteBox" style="display:none;margin-top:6px">';
    h+='<div style="color:#8b9aa8;margin-bottom:4px">Paste a warehouse page: Ctrl+A Ctrl+C (text) <i>or</i> Ctrl+U source (HTML, exact numbers).</div>';
    h+='<textarea id="tcPasteArea" placeholder="paste here..." style="width:100%;height:70px;box-sizing:border-box;background:#0f1419;color:#e6edf3;border:1px solid #2a3744;border-radius:5px;padding:4px;font:11px/1.3 monospace;resize:vertical"></textarea>';
    h+='<button id="tcPasteGo" style="width:100%;margin-top:4px">Parse paste</button></div>';
    p.innerHTML=h;
    document.body.appendChild(p);
    Array.prototype.forEach.call(p.querySelectorAll('button'), function(b){ b.style.cssText='cursor:pointer;background:#1d2630;color:#e6edf3;border:1px solid #2a3744;border-radius:6px;padding:5px 6px;font:inherit'; });
    q('#tcCap').onclick=function(){
      var n = captureWarehouseTable();
      if (n) { status('<b style="color:#3fb950">&#10003; Updated storage for '+n+' villages from table</b>'); }
      else { capture(true); }
    };
    q('#tcDl').onclick=function(){ var blob=new Blob([JSON.stringify(exportPayload(),null,2)],{type:'application/json'});
      var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='travian-sync.json'; a.click(); };
    q('#tcCopy').onclick=function(){ copy(JSON.stringify(exportPayload(),null,2), 'Captured data copied'); };
    q('#tcClear').onclick=function(){ if(confirm('Clear all captured villages?')){ saveStore({}); countLine(); } };
    q('#tcDump').onclick=function(){ copy(diagnostic(), 'Diagnostic copied - paste to Claude'); };
    q('#tcSrc').onclick=function(){ copy(document.documentElement.outerHTML.slice(0,200000), 'Page source copied'); };
    q('#tcPasteToggle').onclick=function(){ var b=q('#tcPasteBox'); b.style.display = b.style.display==='none'?'block':'none'; if(b.style.display==='block') q('#tcPasteArea').focus(); };
    q('#tcPasteGo').onclick=function(){
      var txt = q('#tcPasteArea').value || '';
      if (!txt.trim()){ status('<b style="color:#f0533f">Paste box is empty.</b>'); return; }
      var n = importBlob(txt);
      if (n){ status('<b style="color:#3fb950">&#10003; Updated '+n+' villages from paste</b>'); q('#tcPasteArea').value=''; setTimeout(countLine,2500); }
      else { status('<b style="color:#f0533f">No matching villages found. Visit each village once first so its name/coords are stored.</b>'); }
    };
    countLine();
  }

  var lastKey='', lastTableHash='';
  function tick(){
    // on warehouse overview page, parse the full table
    if (q('#warehouse')) {
      var hash = (document.querySelector('#warehouse tbody') || {innerText:''}).innerText.slice(0,80);
      if (hash !== lastTableHash) { lastTableHash=hash; var n=captureWarehouseTable(); if(n) status('<b style="color:#3fb950">&#10003; Updated '+n+' villages from table</b>'); }
      return;
    }
    var o=readResourcesObj(); if(!o) return;
    var av=readActiveVillage(); var key=av.name+'@'+av.x+'|'+av.y;
    if(key!==lastKey){ lastKey=key; capture(false); }
  }
  function init(){ buildPanel(); setTimeout(tick,800); setInterval(tick,2500); }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
