#!/usr/bin/env python3
# Regenerate the extension's generated files from their single sources, so nothing drifts:
#   extension/content.js  <-  ../travian-commander-sync.user.js   (GM_* shimmed onto chrome.storage)
#   extension/tool.html   <-  ../travian-tool.html                (sandbox shim + sync listener injected)
# Run this after changing either source:  python extension/build.py
import io, os

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
def read(p): return io.open(p, encoding='utf-8').read()
def write(p, s): io.open(p, 'w', encoding='utf-8', newline='\n').write(s); return len(s)

# ---- content.js: the userscript's body with GM_* mapped onto the extension APIs ----
us = read(os.path.join(root, 'travian-commander-sync.user.js'))
i = us.find('(function ()')
if i < 0: i = us.find('(function(')
if i < 0: raise SystemExit('userscript: cannot find the IIFE start')
shim = (
    "// AUTO-GENERATED from ../travian-commander-sync.user.js by build.py - do not edit here.\n"
    "// The userscript uses GM_*/unsafeWindow; in the extension content script we shim those onto\n"
    "// chrome.storage. Only the game (isGame) branch runs here; the isTool branch never fires.\n"
    "// chrome.storage is async but GM_getValue is synchronous, so mirror the store into a cache:\n"
    "// reads hit the cache, onChanged keeps it fresh and drives GM_addValueChangeListener, and\n"
    "// __tcWhenReady defers work that must not run before the first load has landed (the Apply\n"
    "// panel and the resume-after-navigation step both read values written by the dashboard).\n"
    "const __tcCache = {}; const __tcListeners = {}; const __tcReadyCbs = []; let __tcReady = false;\n"
    "const __tcWhenReady = fn => { if (__tcReady) { try { fn(); } catch (e) {} } else __tcReadyCbs.push(fn); };\n"
    "const GM_setValue = (k, v) => { __tcCache[k] = v; try { chrome.storage.local.set({ [k]: v }); } catch (e) {} };\n"
    "const GM_getValue = (k, d) => (Object.prototype.hasOwnProperty.call(__tcCache, k) ? __tcCache[k] : (d === undefined ? null : d));\n"
    "const GM_addValueChangeListener = (k, fn) => { (__tcListeners[k] = __tcListeners[k] || []).push(fn); };\n"
    "const GM_registerMenuCommand = () => {};\n"
    "const unsafeWindow = window;\n"
    "try {\n"
    "  chrome.storage.local.get(null, o => { Object.assign(__tcCache, o || {}); __tcReady = true; __tcReadyCbs.splice(0).forEach(f => { try { f(); } catch (e) {} }); });\n"
    "  chrome.storage.onChanged.addListener((ch, area) => { if (area !== 'local') return; Object.keys(ch).forEach(k => { __tcCache[k] = ch[k].newValue; (__tcListeners[k] || []).forEach(fn => { try { fn(k, ch[k].oldValue, ch[k].newValue); } catch (e) {} }); }); });\n"
    "} catch (e) { __tcReady = true; }\n\n"
)
n1 = write(os.path.join(here, 'content.js'), shim + us[i:])

# ---- tool.html: the dashboard wrapped for the MV3 sandbox ----
src = read(os.path.join(root, 'travian-tool.html'))
if '<body>' not in src or '</body>' not in src:
    raise SystemExit('travian-tool.html: expected a plain <body> and </body>')
out = src.replace('<body>', '<body>\n' + read(os.path.join(here, 'sandbox-shim.html')), 1)
out = out.replace('</body>', read(os.path.join(here, 'sandbox-listener.html')) + '\n</body>', 1)
n2 = write(os.path.join(here, 'tool.html'), out)

print('built extension/content.js (%d bytes) and extension/tool.html (%d bytes)' % (n1, n2))
