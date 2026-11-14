"""Génère les icônes PWA (PNG) : 5 barres aux couleurs des lignes sur fond encre."""
from PIL import Image, ImageDraw
import sys, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
INK, PAPER = (14, 20, 24), (243, 239, 230)
LINES = [(0, 92, 169), (239, 125, 0), (200, 212, 0), (75, 42, 14), (40, 116, 49)]

def render(size, maskable=False):
    s = size * 4
    img = Image.new('RGBA', (s, s), INK + (255,))
    d = ImageDraw.Draw(img)
    pad = s * (0.22 if maskable else 0.14)
    inner = s - 2 * pad
    bar_h = inner / (len(LINES) * 2 - 1)
    for i, c in enumerate(LINES):
        y0 = pad + i * 2 * bar_h
        # barres décalées en escalier : évoque un tracé de lignes qui se croisent
        x0 = pad + inner * (0.0 + 0.06 * i)
        x1 = pad + inner * (1.0 - 0.06 * (len(LINES) - 1 - i))
        d.rounded_rectangle([x0, y0, x1, y0 + bar_h], radius=bar_h / 2, fill=c + (255,))
    r = inner * 0.13
    cx, cy = s * 0.5, s * 0.5
    d.ellipse([cx - r * 1.45, cy - r * 1.45, cx + r * 1.45, cy + r * 1.45], fill=INK + (255,))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=PAPER + (255,))
    if not maskable:
        mask = Image.new('L', (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, s, s], radius=s * 0.22, fill=255)
        out = Image.new('RGBA', (s, s), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        img = out
    return img.resize((size, size), Image.LANCZOS)

for name, size, maskable in [('icon-192.png', 192, False), ('icon-512.png', 512, False),
                              ('icon-maskable-512.png', 512, True), ('apple-touch-icon.png', 180, True),
                              ('favicon-32.png', 32, False)]:
    render(size, maskable).save(os.path.join(OUT, name))
    print('ok', name)
