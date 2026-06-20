// ==UserScript==
// @name         Travian Resource Commander - Sync (read-only)
// @namespace    travian-commander
// @version      2.2
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
    p.innerHTML=h;
    document.body.appendChild(p);
    Array.prototype.forEach.call(p.querySelectorAll('button'), function(b){ b.style.cssText='cursor:pointer;background:#1d2630;color:#e6edf3;border:1px solid #2a3744;border-radius:6px;padding:5px 6px;font:inherit'; });
    q('#tcCap').onclick=function(){ capture(true); };
    q('#tcDl').onclick=function(){ var blob=new Blob([JSON.stringify(exportPayload(),null,2)],{type:'application/json'});
      var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='travian-sync.json'; a.click(); };
    q('#tcCopy').onclick=function(){ copy(JSON.stringify(exportPayload(),null,2), 'Captured data copied'); };
    q('#tcClear').onclick=function(){ if(confirm('Clear all captured villages?')){ saveStore({}); countLine(); } };
    q('#tcDump').onclick=function(){ copy(diagnostic(), 'Diagnostic copied - paste to Claude'); };
    q('#tcSrc').onclick=function(){ copy(document.documentElement.outerHTML.slice(0,200000), 'Page source copied'); };
    countLine();
  }

  var lastKey='';
  function tick(){
    var o=readResourcesObj(); if(!o) return;
    var av=readActiveVillage(); var key=av.name+'@'+av.x+'|'+av.y;
    if(key!==lastKey){ lastKey=key; capture(false); }
  }
  function init(){ buildPanel(); setTimeout(tick,800); setInterval(tick,2500); }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
