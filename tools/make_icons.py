"""Generate GPS Verify PWA icons (real PNGs, no CDN / data-URI dependency).

Design: rounded-square brand-blue tile, white disc, full-colour antenna glyph
rendered from the system Segoe UI Emoji font. Rendered at 4x and downsampled
with LANCZOS so every edge is cleanly antialiased.

The emoji is drawn as a real bitmap by the OS font engine, so it stays crisp
and consistent instead of hand-drawn geometry.
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend'))

PRIMARY = (13, 110, 253, 255)      # #0d6efd
DARK    = (11, 79, 193, 255)       # #0b4fc1
WHITE   = (255, 255, 255, 255)

SS = 4                       # supersampling factor
EMOJI_FONT = r'C:\Windows\Fonts\seguiemj.ttf'
GLYPH = '\U0001F4E1'          # satellite antenna


def render_glyph(px):
    """Render the emoji to a tight-cropped RGBA image of the given size."""
    font = ImageFont.truetype(EMOJI_FONT, int(px * 1.6))
    tmp = Image.new('RGBA', (int(px * 2.4), int(px * 2.4)), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    # centre the glyph in the temp canvas using measured offsets
    l, t, r, b = d.textbbox((0, 0), GLYPH, font=font, embedded_color=True)
    d.text(
        ((tmp.width - (r - l)) / 2 - l, (tmp.height - (b - t)) / 2 - t),
        GLYPH, font=font, embedded_color=True,
    )
    bbox = tmp.getbbox()
    if bbox:
        tmp = tmp.crop(bbox)
    return tmp.resize((px, px), Image.LANCZOS)


def render(size, maskable=False):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # full-bleed background so Android can crop to any shape safely
        d.rectangle([0, 0, S - 1, S - 1], fill=PRIMARY)
        d.rectangle([0, int(S * 0.82), S - 1, S - 1], fill=DARK)
        disc_r = S * 0.29
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=PRIMARY)
        d.rectangle([0, int(S * 0.82), S - 1, S - 1], fill=DARK)
        disc_r = S * 0.345

    cx = cy = S / 2
    # white disc gives the grey/blue emoji a clean, high-contrast backdrop
    d.ellipse([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r], fill=WHITE)

    glyph_px = int(disc_r * 1.42)
    glyph = render_glyph(glyph_px)
    img.alpha_composite(glyph, (int(cx - glyph.width / 2), int(cy - glyph.height / 2)))

    return img.resize((size, size), Image.LANCZOS)


def main():
    jobs = [
        ('icon-192.png',           192, False),
        ('icon-512.png',           512, False),
        ('icon-maskable-512.png',  512, True),
        ('apple-touch-icon.png',   180, False),
        ('favicon-32.png',          32, False),
    ]
    for name, size, maskable in jobs:
        img = render(size, maskable=maskable)
        img.save(os.path.join(OUT, name), 'PNG')
        print(f'wrote {name} ({size}x{size})')

    ico = render(64, maskable=False)
    ico.save(os.path.join(OUT, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print('wrote favicon.ico')

    # visual QA strip: real sizes side by side
    preview = Image.new('RGBA', (300, 90), (245, 245, 248, 255))
    for i, sz in enumerate([64, 32, 16]):
        im = Image.open(os.path.join(OUT, 'icon-192.png')).convert('RGBA').resize((sz, sz), Image.LANCZOS)
        preview.alpha_composite(im, (20 + i * 74, 13))
    mk = Image.open(os.path.join(OUT, 'icon-maskable-512.png')).convert('RGBA').resize((64, 64), Image.LANCZOS)
    preview.alpha_composite(mk, (242, 13))
    preview.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon_preview.png'))
    print('wrote tools/icon_preview.png')


if __name__ == '__main__':
    main()
