#!/usr/bin/env python3
# Regenerate extension/tool.html from the canonical ../travian-tool.html by injecting the
# sandbox localStorage shim (after <body>) and the sync listener (before </body>).
# Run this whenever travian-tool.html changes:  python extension/build.py
import io, os

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)

def read(p): return io.open(p, encoding='utf-8').read()

src = read(os.path.join(root, 'travian-tool.html'))
shim = read(os.path.join(here, 'sandbox-shim.html'))
listener = read(os.path.join(here, 'sandbox-listener.html'))

if '<body>' not in src or '</body>' not in src:
    raise SystemExit('travian-tool.html: expected a plain <body> and </body>')

out = src.replace('<body>', '<body>\n' + shim, 1)
out = out.replace('</body>', listener + '\n</body>', 1)

io.open(os.path.join(here, 'tool.html'), 'w', encoding='utf-8').write(out)
print('built extension/tool.html (%d bytes)' % len(out))
