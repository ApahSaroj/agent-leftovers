import sys, os
sys.path.insert(0, '/workspace/work/.pylib')
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 2  # render scale
W, H = 1270 * S, 760 * S
F = '/workspace/work/fonts/'
INTER = F + 'inter/extras/ttf/Inter-'
def inter(w, size): return ImageFont.truetype(f'{INTER}{w}.ttf', int(size * S))
def mono(w, size): return ImageFont.truetype(f'{F}JetBrainsMono-{w}.ttf', int(size * S))

BG1 = (11, 13, 22); BG2 = (22, 18, 40)
INK = (240, 242, 248); MUTED = (148, 155, 178); DIM = (98, 104, 128)
CORAL = (255, 107, 107); AMBER = (255, 190, 92); CYAN = (94, 220, 240)
VIOLET = (170, 140, 255); GREEN = (110, 220, 150)
CARD = (24, 27, 40); CARD2 = (30, 34, 50); LINE = (52, 57, 80)

OUT = '/workspace/work/agent-leftovers/ph/v2/'
os.makedirs(OUT, exist_ok=True)

def base(glow=(CORAL, CYAN)):
    img = Image.new('RGB', (W, H), BG1)
    # vertical gradient
    g = Image.new('RGB', (1, H))
    for y in range(H):
        t = y / H
        g.putpixel((0, y), tuple(int(BG1[i] * (1 - t) + BG2[i] * t) for i in range(3)))
    img = g.resize((W, H))
    # soft glows
    lay = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.ellipse([-300 * S, -350 * S, 500 * S, 350 * S], fill=tuple(int(c * .35) for c in glow[0]))
    d.ellipse([850 * S, 420 * S, 1600 * S, 1100 * S], fill=tuple(int(c * .28) for c in glow[1]))
    lay = lay.filter(ImageFilter.GaussianBlur(180 * S))
    img = Image.eval(Image.merge('RGB', [Image.eval(a, lambda v: v) for a in img.split()]), lambda v: v)
    from PIL import ImageChops
    img = ImageChops.add(img, lay)
    # subtle dot grid
    d = ImageDraw.Draw(img)
    for x in range(0, W, 28 * S):
        for y in range(0, H, 28 * S):
            d.point((x, y), fill=(40, 44, 64))
    return img

def shadowed_card(img, box, r=18, fill=CARD, outline=LINE, shadow=40):
    x0, y0, x1, y1 = box
    sh = Image.new('L', (W, H), 0)
    ImageDraw.Draw(sh).rounded_rectangle([x0, y0 + 14 * S, x1, y1 + 14 * S], r * S, fill=170)
    sh = sh.filter(ImageFilter.GaussianBlur(shadow * S / 2))
    black = Image.new('RGB', (W, H), (0, 0, 0))
    img.paste(black, (0, 0), sh)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(box, r * S, fill=fill, outline=outline, width=max(1, S))
    return d

def pill(d, xy, text, font, fg, bg, padx=12, pady=6, outline=None):
    x, y = xy
    tw = d.textlength(text, font=font)
    asc, desc = font.getmetrics()
    h = asc + desc
    box = [x, y, x + tw + 2 * padx * S, y + h + 2 * pady * S]
    d.rounded_rectangle(box, (h + 2 * pady * S) // 2, fill=bg, outline=outline, width=S if outline else 0)
    d.text((x + padx * S, y + pady * S), text, font=font, fill=fg)
    return box

def brand(d, x=70, y=52):
    # small logo mark + wordmark
    X, Y = x * S, y * S
    d.rounded_rectangle([X, Y, X + 34 * S, Y + 34 * S], 9 * S, fill=CARD2, outline=LINE, width=S)
    d.text((X + 7 * S, Y + 3 * S), '>', font=mono('Bold', 21), fill=CYAN)
    d.ellipse([X + 22 * S, Y + 22 * S, X + 36 * S, Y + 36 * S], fill=CORAL)
    d.text((X + 46 * S, Y + 5 * S), 'agent-leftovers', font=inter('SemiBold', 19), fill=INK)

def terminal(img, box, lines, title='zsh — agent-leftovers'):
    d = shadowed_card(img, box, r=16, fill=(16, 18, 28))
    x0, y0, x1, y1 = box
    d.rounded_rectangle([x0, y0, x1, y0 + 40 * S], 16 * S, fill=(28, 31, 46))
    d.rectangle([x0, y0 + 24 * S, x1, y0 + 40 * S], fill=(28, 31, 46))
    d.line([x0, y0 + 40 * S, x1, y0 + 40 * S], fill=LINE, width=S)
    for i, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        cx = x0 + (22 + i * 20) * S; cy = y0 + 20 * S
        d.ellipse([cx - 6 * S, cy - 6 * S, cx + 6 * S, cy + 6 * S], fill=c)
    f = mono('Regular', 12)
    tw = d.textlength(title, font=f)
    d.text(((x0 + x1 - tw) / 2, y0 + 12 * S), title, font=f, fill=DIM)
    y = y0 + 60 * S
    for ln in lines:
        if ln is None:
            y += 10 * S; continue
        x = x0 + 26 * S
        size = 15
        for seg in ln:
            text, col = seg[0], seg[1]
            w = seg[2] if len(seg) > 2 else 'Regular'
            fo = mono(w, size)
            d.text((x, y), text, font=fo, fill=col)
            x += d.textlength(text, font=fo)
        y += 25 * S
    return d

def save(img, name):
    img.save(OUT + name, optimize=True)
    img.resize((W // S, H // S), Image.LANCZOS).save(OUT + name.replace('.png', '@1x.png'), optimize=True)

# ---------- 1. Hero ----------
def hero():
    img = base()
    d = ImageDraw.Draw(img)
    brand(d)
    x = 70 * S
    pill(d, (x, 130 * S), 'v0.2  ·  now catches MCP too', inter('SemiBold', 14), CYAN, (20, 44, 56), outline=(40, 90, 110))
    y = 190 * S
    for ln, col in [('Find the cloud', INK), ('bills your AI', INK), ('agent left', CORAL), ('running.', CORAL)]:
        d.text((x, y), ln, font=inter('ExtraBold', 54), fill=col); y += 64 * S
    d.text((x, y + 18 * S), 'Reads Claude Code and Codex logs on your', font=inter('Regular', 19), fill=MUTED)
    d.text((x, y + 46 * S), 'machine. Lists every leftover with the', font=inter('Regular', 19), fill=MUTED)
    d.text((x, y + 74 * S), 'exact command to turn it off.', font=inter('Regular', 19), fill=MUTED)
    by = y + 130 * S
    b = pill(d, (x, by), '$ npx github:ApahSaroj/agent-leftovers', mono('Medium', 15), INK, CARD2, padx=16, pady=10, outline=LINE)
    lines = [
        [('$ ', GREEN, 'Bold'), ('npx agent-leftovers', INK, 'Bold')],
        None,
        [('4 things your agent left running', CORAL, 'Bold')],
        None,
        [('● ', CORAL), ('GPU VM      ', INK, 'Bold'), ('llm-worker-1', MUTED)],
        [('  turn off: ', CYAN), ('gcloud compute', INK)],
        [('  instances delete llm-worker-1', INK)],
        None,
        [('● ', CORAL), ('Disk 250 GB ', INK, 'Bold'), ('scratch-250', MUTED)],
        [('  turn off: ', CYAN), ('gcloud compute disks', INK)],
        [('  delete scratch-250', INK)],
        None,
        [('● ', AMBER), ('Postgres DB ', INK, 'Bold'), ('demo-db', MUTED)],
        [('  via MCP: ', VIOLET), ('supabase', INK)],
        None,
        None,
        [('● ', VIOLET), ('Script      ', INK, 'Bold'), ('batch_summarize.py', MUTED)],
        [('  calls OpenAI with your key, in a loop', MUTED)],
        None,
        [('Read-only: nothing was run or changed.', DIM)],
    ]
    terminal(img, [655 * S, 112 * S, 1200 * S, 642 * S], lines)
    save(img, '01-hero.png')

# ---------- 2. Problem ----------
def problem():
    img = base(glow=(CORAL, VIOLET))
    d = ImageDraw.Draw(img)
    brand(d)
    x = 70 * S
    d.text((x, 140 * S), 'Your agent finished the task.', font=inter('ExtraBold', 48), fill=INK)
    d.text((x, 200 * S), 'What it created kept billing.', font=inter('ExtraBold', 48), fill=CORAL)
    d.text((x, 272 * S), 'Agents spin up servers, disks and databases mid-task, then never mention them again.',
           font=inter('Regular', 19), fill=MUTED)
    items = [
        ('GPU virtual machine', 'Compute Engine', 'billed hourly', CORAL),
        ('250 GB disk', 'Persistent disk', 'billed hourly', CORAL),
        ('Postgres database', 'Supabase via MCP', 'billed monthly', AMBER),
        ('Background script', 'calls OpenAI with your key', 'billed per call', VIOLET),
    ]
    cw, ch, gap = 262, 230, 24
    for i, (t, sub, tag, col) in enumerate(items):
        cx = x + i * (cw + gap) * S; cy = 350 * S
        dd = shadowed_card(img, [cx, cy, cx + cw * S, cy + ch * S], r=18)
        dd.rounded_rectangle([cx + 24 * S, cy - 1 * S, cx + 84 * S, cy + 4 * S], 2 * S, fill=col)
        dd.ellipse([cx + 24 * S, cy + 34 * S, cx + 36 * S, cy + 46 * S], fill=col)
        dd.text((cx + 46 * S, cy + 30 * S), 'still running', font=inter('SemiBold', 14), fill=col)
        dd.text((cx + 24 * S, cy + 78 * S), t, font=inter('Bold', 22), fill=INK)
        dd.text((cx + 24 * S, cy + 112 * S), sub, font=inter('Regular', 16), fill=MUTED)
        pill(dd, (cx + 24 * S, cy + 168 * S), tag, inter('SemiBold', 14), col, tuple(int(c * .18) for c in col))
    d.text((x, 640 * S), 'Nobody remembers them until the bill arrives.', font=inter('SemiBold', 20), fill=INK)
    save(img, '02-problem.png')

# ---------- 3. How it works ----------
def how():
    img = base(glow=(CYAN, VIOLET))
    d = ImageDraw.Draw(img)
    brand(d)
    x = 70 * S
    d.text((x, 140 * S), 'One command. Three steps.', font=inter('ExtraBold', 48), fill=INK)
    d.text((x, 208 * S), 'No sign-up, no cloud keys, nothing to configure.', font=inter('Regular', 20), fill=MUTED)
    steps = [
        ('1', 'Reads the logs', 'Claude Code and Codex already save every command your agent ran, right on your machine.', CYAN),
        ('2', 'Spots what it created', '59 shell rules and 24 MCP providers. Skips what was deleted or failed.', VIOLET),
        ('3', 'Shows how to turn it off', 'Each leftover comes with the exact teardown command. You choose what to run.', CORAL),
    ]
    cw, ch, gap = 352, 270, 27
    for i, (n, t, body, col) in enumerate(steps):
        cx = x + i * (cw + gap) * S; cy = 290 * S
        dd = shadowed_card(img, [cx, cy, cx + cw * S, cy + ch * S], r=20)
        dd.rounded_rectangle([cx + 30 * S, cy + 32 * S, cx + 86 * S, cy + 88 * S], 14 * S,
                             fill=tuple(int(c * .18) for c in col), outline=col, width=S)
        f = inter('ExtraBold', 26); tw = dd.textlength(n, font=f)
        dd.text((cx + 58 * S - tw / 2, cy + 43 * S), n, font=f, fill=col)
        dd.text((cx + 30 * S, cy + 118 * S), t, font=inter('Bold', 24), fill=INK)
        # wrap body
        words, line, yy = body.split(), '', cy + 166 * S
        fb = inter('Regular', 17)
        for w in words:
            test = (line + ' ' + w).strip()
            if dd.textlength(test, font=fb) > (cw - 60) * S:
                dd.text((cx + 30 * S, yy), line, font=fb, fill=MUTED); yy += 27 * S; line = w
            else:
                line = test
        dd.text((cx + 30 * S, yy), line, font=fb, fill=MUTED)
        if i < 2:
            ax = cx + cw * S + 4 * S; ay = cy + ch * S // 2
            dd.polygon([(ax + 4 * S, ay - 8 * S), (ax + 18 * S, ay), (ax + 4 * S, ay + 8 * S)], fill=DIM)
    d.text((x, 612 * S), 'Optional --verify asks your own cloud CLIs which leftovers still exist (read-only).',
           font=inter('Medium', 17), fill=DIM)
    save(img, '03-how-it-works.png')

# ---------- 4. Coverage ----------
def coverage():
    img = base(glow=(VIOLET, CYAN))
    d = ImageDraw.Draw(img)
    brand(d)
    x = 70 * S
    d.text((x, 140 * S), 'Covers the clouds agents reach for.', font=inter('ExtraBold', 46), fill=INK)
    groups = [
        ('SHELL COMMANDS', CYAN, ['Google Cloud', 'AWS', 'Azure', 'Cloudflare', 'Vercel', 'Netlify', 'Fly.io',
                                  'Heroku', 'Railway', 'Firebase', 'Modal', 'RunPod', 'Terraform', 'Pulumi', 'CDK', 'Serverless']),
        ('MCP SERVERS  ·  NEW IN v0.2', VIOLET, ['Supabase', 'Neon', 'Vercel', 'Cloudflare', 'AWS', 'Google Cloud',
                                              'Azure', 'Railway', 'Render', 'DigitalOcean', 'MongoDB', 'Turso', 'E2B', 'and more']),
        ('PAID AI APIs', CORAL, ['Scripts calling OpenAI, Anthropic or Gemini with your key, even in the background']),
    ]
    d.text((x, 206 * S), 'Shell commands, MCP tool calls and paid AI APIs, in one scan.', font=inter('Regular', 20), fill=MUTED)
    y = 272 * S
    fp = inter('Medium', 16)
    for label, col, names in groups:
        d.text((x, y), label, font=inter('Bold', 13), fill=col)
        y += 30 * S
        px = x
        for nm in names:
            tw = d.textlength(nm, font=fp) + 28 * S
            if px + tw > (1270 - 70) * S:
                px = x; y += 46 * S
            pill(d, (px, y), nm, fp, INK, CARD2, padx=14, pady=8, outline=tuple(int(c * .45) for c in col))
            px += tw + 10 * S
        y += 84 * S
    save(img, '04-coverage.png')

# ---------- 5. Trust ----------
def trust():
    img = base(glow=(GREEN, CYAN))
    d = ImageDraw.Draw(img)
    brand(d)
    x = 70 * S
    d.text((x, 140 * S), 'Safe to run on any machine.', font=inter('ExtraBold', 48), fill=INK)
    d.text((x, 208 * S), 'It only reads. It never deletes anything for you.', font=inter('Regular', 20), fill=MUTED)
    cards = [
        ('Read-only', 'Prints commands. Runs none of them.'),
        ('Fully local', 'Your logs never leave your laptop.'),
        ('No telemetry', 'No account, no tracking, no keys.'),
        ('Open source', 'MIT licence. Zero dependencies.'),
    ]
    cw, ch, gx, gy = 525, 150, 30, 26
    for i, (t, b) in enumerate(cards):
        cx = x + (i % 2) * (cw + gx) * S; cy = 290 * S + (i // 2) * (ch + gy) * S
        dd = shadowed_card(img, [cx, cy, cx + cw * S, cy + ch * S], r=18)
        # check icon
        ix, iy = cx + 30 * S, cy + 40 * S
        dd.ellipse([ix, iy, ix + 44 * S, iy + 44 * S], fill=(22, 60, 44), outline=GREEN, width=S)
        dd.line([(ix + 12 * S, iy + 23 * S), (ix + 19 * S, iy + 30 * S), (ix + 32 * S, iy + 15 * S)], fill=GREEN, width=4 * S, joint='curve')
        dd.text((cx + 96 * S, cy + 38 * S), t, font=inter('Bold', 25), fill=INK)
        dd.text((cx + 96 * S, cy + 80 * S), b, font=inter('Regular', 18), fill=MUTED)
    pill(d, (x, 660 * S), '$ npx github:ApahSaroj/agent-leftovers', mono('Medium', 15), INK, CARD2, padx=16, pady=9, outline=LINE)
    save(img, '05-trust.png')

# ---------- Thumbnail ----------
def thumb():
    T = 480
    img = Image.new('RGB', (T, T), BG1)
    g = Image.new('RGB', (1, T))
    for y in range(T):
        t = y / T
        g.putpixel((0, y), tuple(int((36, 40, 64)[i] * (1 - t) + (14, 15, 26)[i] * t) for i in range(3)))
    img = g.resize((T, T))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(F + 'JetBrainsMono-Bold.ttf', 200)
    # chevron + underscore, centred as a group
    d.text((70, 100), '>', font=f, fill=CYAN)
    d.rounded_rectangle([210, 300, 300, 326], 12, fill=CYAN)
    d.ellipse([280, 236, 410, 366], fill=CORAL, outline=(20, 22, 36), width=12)
    fe = ImageFont.truetype(INTER + 'ExtraBold.ttf', 92)
    bb = d.textbbox((0, 0), '!', font=fe)
    d.text((345 - (bb[0] + bb[2]) / 2, 301 - (bb[1] + bb[3]) / 2), '!', font=fe, fill=(255, 255, 255))
    img.save(OUT + 'thumbnail.png', optimize=True)
    img.resize((240, 240), Image.LANCZOS).save(OUT + 'thumbnail@240.png', optimize=True)

hero(); problem(); how(); coverage(); trust(); thumb()
print('ok')
