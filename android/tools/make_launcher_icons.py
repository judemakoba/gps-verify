"""Generate the Android launcher icons for the GPS Verify app.

The design matches the PWA icon (rounded brand-blue tile, white disc, antenna
glyph) so the app looks like the same product on the handset.

Outputs:
  res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png
  res/mipmap-{...}/ic_launcher_round.png
  res/drawable-{...}/ic_launcher_foreground.png   (adaptive-icon foreground)
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
RES = os.path.join(ROOT, 'app', 'src', 'main', 'res')

PRIMARY = (13, 110, 253, 255)      # #0d6efd
DARK    = (11, 79, 193, 255)       # #0b4fc1
WHITE   = (255, 255, 255, 255)

SS = 4                       # supersampling factor
EMOJI_FONT = r'C:\Windows\Fonts\seguiemj.ttf'
GLYPH = '\U0001F4E1'          # satellite antenna

# Launcher icon sizes per density bucket.
DENSITIES = {
    'mdpi':    48,
    'hdpi':    72,
    'xhdpi':   96,
    'xxhdpi':  144,
    'xxxhdpi': 192,
}
# Adaptive foreground is 108dp; the inner 72dp is the visible safe zone.
FOREGROUND = {
    'mdpi':    108,
    'hdpi':    162,
    'xhdpi':   216,
    'xxhdpi':  324,
    'xxxhdpi': 432,
}


def render_glyph(px):
    """Render the antenna emoji to a tight-cropped RGBA image."""
    font = ImageFont.truetype(EMOJI_FONT, int(px * 1.6))
    tmp = Image.new('RGBA', (int(px * 2.4), int(px * 2.4)), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    l, t, r, b = d.textbbox((0, 0), GLYPH, font=font, embedded_color=True)
    d.text(((tmp.width - (r - l)) / 2 - l, (tmp.height - (b - t)) / 2 - t),
           GLYPH, font=font, embedded_color=True)
    bbox = tmp.getbbox()
    if bbox:
        tmp = tmp.crop(bbox)
    return tmp.resize((px, px), Image.LANCZOS)


def render_legacy(size, round_icon=False):
    """Full square/circle launcher icon."""
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if round_icon:
        d.ellipse([0, 0, S - 1, S - 1], fill=PRIMARY)
        d.chord([0, int(S * 0.80), S - 1, S - 1], 0, 180, fill=DARK)
        disc_r = S * 0.30
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=PRIMARY)
        d.rectangle([0, int(S * 0.82), S - 1, S - 1], fill=DARK)
        disc_r = S * 0.345

    cx = cy = S / 2
    d.ellipse([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r], fill=WHITE)

    glyph_px = int(disc_r * 1.42)
    glyph = render_glyph(glyph_px)
    img.alpha_composite(glyph, (int(cx - glyph.width / 2), int(cy - glyph.height / 2)))

    return img.resize((size, size), Image.LANCZOS)


def render_foreground(size):
    """Adaptive-icon foreground: glyph only, inside the 72/108 safe zone."""
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx = cy = S / 2
    disc_r = S * 0.24                       # 48/108 of the canvas -> safe zone
    d.ellipse([cx - disc_r, cy - disc_r, cx + disc_r, cy + disc_r], fill=WHITE)

    glyph_px = int(disc_r * 1.45)
    glyph = render_glyph(glyph_px)
    img.alpha_composite(glyph, (int(cx - glyph.width / 2), int(cy - glyph.height / 2)))

    return img.resize((size, size), Image.LANCZOS)


def main():
    for bucket, size in DENSITIES.items():
        outdir = os.path.join(RES, f'mipmap-{bucket}')
        os.makedirs(outdir, exist_ok=True)
        render_legacy(size).save(os.path.join(outdir, 'ic_launcher.png'), 'PNG')
        render_legacy(size, round_icon=True).save(os.path.join(outdir, 'ic_launcher_round.png'), 'PNG')
        print(f'wrote mipmap-{bucket} ({size}x{size})')

    for bucket, size in FOREGROUND.items():
        outdir = os.path.join(RES, f'drawable-{bucket}')
        os.makedirs(outdir, exist_ok=True)
        render_foreground(size).save(os.path.join(outdir, 'ic_launcher_foreground.png'), 'PNG')
        print(f'wrote drawable-{bucket} foreground ({size}x{size})')

    # A small preview strip for visual QA.
    preview = Image.new('RGBA', (320, 120), (245, 246, 248, 255))
    x = 12
    for bucket in ('mdpi', 'hdpi', 'xhdpi', 'xxhdpi'):
        p = os.path.join(RES, f'mipmap-{bucket}', 'ic_launcher.png')
        im = Image.open(p).convert('RGBA').resize((64, 64), Image.LANCZOS)
        preview.alpha_composite(im, (x, 16))
        x += 74
    preview.save(os.path.join(ROOT, 'icon_preview.png'))
    print('wrote icon_preview.png')


if __name__ == '__main__':
    main()
