#!/usr/bin/env python3
"""Render real agent-leftovers terminal output (with ANSI colors) to a PNG for the README.
usage: python3 demo/render.py output.ansi docs/demo.png"""
import re, sys
from PIL import Image, ImageDraw, ImageFont

src, out = sys.argv[1], sys.argv[2]
COLS = 128
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
FONTB = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
SIZE = 15
f, fb = ImageFont.truetype(FONT, SIZE), ImageFont.truetype(FONTB, SIZE)
cw = f.getbbox('M')[2]
lh = int(SIZE * 1.45)
BG, FG = (17, 19, 24), (214, 218, 226)
COL = {'31': (255, 107, 107), '32': (105, 219, 124), '33': (255, 199, 89), '35': (218, 119, 242), '36': (102, 217, 239)}

def parse(line):
    segs, st = [], {'c': None, 'b': False, 'd': False}
    pos = 0
    for m in re.finditer(r'\x1b\[(\d+)m', line):
        if m.start() > pos: segs.append((line[pos:m.start()], dict(st)))
        code = m.group(1)
        if code == '0': st = {'c': None, 'b': False, 'd': False}
        elif code == '1': st['b'] = True
        elif code == '2': st['d'] = True
        else: st['c'] = code
        pos = m.end()
    if pos < len(line): segs.append((line[pos:], dict(st)))
    return segs

def wrap(segs):
    rows, cur, n = [], [], 0
    indent = None
    for text, st in segs:
        while text:
            room = COLS - n
            if len(text) <= room:
                cur.append((text, st)); n += len(text); text = ''
            else:
                cut = text.rfind(' ', 0, room)
                if cut <= 0: cut = room
                cur.append((text[:cut], st)); rows.append(cur)
                text = text[cut:].lstrip(' ')
                cur, n = [('            ', st)], 12
    rows.append(cur)
    return rows

lines = ['\x1b[36m$\x1b[0m \x1b[1mnpx agent-leftovers\x1b[0m'] + open(src, encoding='utf8').read().rstrip('\n').split('\n')
rows = []
for l in lines: rows += wrap(parse(l))
pad, bar = 28, 40
W = pad * 2 + COLS * cw
H = bar + pad + len(rows) * lh + pad
img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)
d.rectangle([0, 0, W, bar], fill=(32, 35, 43))
for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
    d.ellipse([16 + i * 22, 14, 28 + i * 22, 26], fill=c)
d.text((W // 2 - 90, 11), 'agent-leftovers 0.4.0', font=f, fill=(140, 146, 158))
y = bar + pad
for r in rows:
    x = pad
    for text, st in r:
        col = COL.get(st['c'], FG)
        if st['d'] and not st['c']: col = (120, 126, 138)
        elif st['d']: col = tuple(int(v * 0.7) for v in col)
        d.text((x, y), text, font=fb if st['b'] else f, fill=col)
        x += len(text) * cw
    y += lh
img.save(out, optimize=True)
print(out, img.size)
