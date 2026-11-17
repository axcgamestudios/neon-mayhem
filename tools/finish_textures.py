#!/usr/bin/env python3
# Texture finishing pipeline for neon-mayhem's ground set (media/textures).
#
# The masters are photo-real 1024px images (an image model works well for
# stochastic surfaces: asphalt aggregate, concrete speckle, sand grain,
# stucco); this script is everything AFTER that, and it is deterministic:
#   tileable seams   - offset by half, cross-fade the seam cross, offset back
#   de-lighting      - divide out the baked low-frequency lighting so the
#                      albedo carries no shadows of its own
#   hue neutralising - ground textures stay grey for the city's vertex tints
#                      (the sand keeps half its warmth; a beach is allowed)
#   concrete joints  - saw cuts on a running-bond grid, wobbled, with a pale
#                      chipped lip and a dark trough (drawn, not generated:
#                      the model gave us pavers in perspective instead)
#   normal + rough   - derived from the de-lighted luminance (Sobel), at the
#                      sizes the game ships: 2048 albedo / 1024 n + r
# Requires: pillow, numpy, scipy. Masters: asphalt.png concrete2.png sand.png
# plaster.png in $TEXGEN_SRC (default /tmp/texgen).
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

# where the photo masters live (see the header note)
import os
SRC = os.environ.get('TEXGEN_SRC', '/tmp/texgen')
DST = '/home/z/my-project/neon-mayhem/media/textures'

def to_f(img):
    return np.asarray(img.convert('RGB'), dtype=np.float32) / 255.0

def to_img(a):
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), 'RGB')

def make_tileable(a, blend=0.18):
    """Offset by half, cross-fade the seam cross, offset back."""
    n = a.shape[0]
    m = max(8, int(n * blend))
    b = np.roll(np.roll(a, n // 2, axis=0), n // 2, axis=1)
    # smooth ramp 0..1 across the horizontal seam band (rows around n/2)
    ramp = np.zeros(n)
    lo, hi = n // 2 - m, n // 2 + m
    ramp[lo:hi] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, hi - lo))
    w = ramp[:, None, None]
    # blend a (weight ramp) with its y-neighbour across the seam
    shifted = np.roll(b, -1, axis=0)
    b = b * (1 - w) + shifted * w
    # same for the vertical seam
    w2 = ramp[None, :, None]
    shifted2 = np.roll(b, -1, axis=1)
    b = b * (1 - w2) + shifted2 * w2
    return np.roll(np.roll(b, -(n // 2), axis=0), -(n // 2), axis=1)

def delight(a, sigma=48, keep=0.92, mid_sigma=None):
    """Remove baked low-frequency lighting (AI vignettes, ripple shading,
    the asphalt oval) by dividing by a heavy blur, keeping the detail.
    `mid_sigma` also flattens mid-scale shading (sand ripples) while the
    grain stays."""
    lum = a.mean(axis=2, keepdims=True)
    low = np.stack([ndimage.gaussian_filter(lum[:, :, 0], sigma)] * 3, axis=2)
    if mid_sigma:
        low = np.maximum(low, 0.05)
        low = low * 0.35 + 0.65 * np.stack(
            [ndimage.gaussian_filter(lum[:, :, 0], mid_sigma)] * 3, axis=2)
    low = np.maximum(low, 0.05)
    flat = a / (low * 2.0)  # centre around 1
    # restore the original tonality
    m0, s0 = a.mean(), a.std()
    m1, s1 = flat.mean(), flat.std() + 1e-6
    out = (flat - m1) * (s0 / s1 * keep) + m0
    return out

def neutral_hue(a, strength=0.85):
    """Ground textures stay hue-neutral: the city tints streets by vertex
    colour, and a warm master would fight every tint it met."""
    lum = a.mean(axis=2, keepdims=True)
    mean_rgb = a.mean(axis=(0, 1), keepdims=True)
    grey_target = mean_rgb.mean()
    neutral = a + (lum - a)  # pure grey of same luminance
    # desaturate toward luminance, but keep a whisper of the original cast
    out = a * (1 - strength) + neutral * strength
    # keep overall brightness
    out *= (grey_target / max(out.mean(), 1e-4))
    return out

def height_from(a, detail_sigma=1.2, large_sigma=10):
    lum = a.mean(axis=2)
    fine = ndimage.gaussian_filter(lum, detail_sigma)
    large = ndimage.gaussian_filter(lum, large_sigma)
    return fine - large

def normal_map(a, strength=1.6, size=1024):
    h = height_from(a)
    gy = ndimage.sobel(h, axis=0) * strength
    gx = ndimage.sobel(h, axis=1) * strength
    n = np.stack([-gx, -gy, np.ones_like(gx) * 2.0], axis=2)
    L = np.sqrt((n ** 2).sum(axis=2, keepdims=True))
    n = n / L
    n = n * 0.5 + 0.5
    img = to_img(n).resize((size, size), Image.LANCZOS)
    return img

def roughness_map(a, base=0.9, contrast=0.5, size=1024):
    lum = a.mean(axis=2)
    r = base - (lum - lum.mean()) * contrast
    r = ndimage.gaussian_filter(r, 1.0)
    r = np.clip(r, 0.35, 0.98)
    img = to_img(np.stack([r] * 3, axis=2)).resize((size, size), Image.LANCZOS)
    return img

def add_speckle(a, amount=0.05, scale=1.5):
    """Fine high-frequency grain so the 2x upscale isn't soft up close."""
    n = a.shape[0]
    rng = np.random.default_rng(7)
    grain = rng.normal(0, 1, (n, n, 1)).astype(np.float32)
    grain = ndimage.gaussian_filter(grain, scale) - ndimage.gaussian_filter(grain, scale * 3)
    grain /= (np.abs(grain).max() + 1e-6)
    return a + grain * amount

def save(img, name, quality=88):
    img.save(f'{DST}/{name}.jpg', quality=quality, optimize=True)
    print('wrote', name + '.jpg', img.size)

def build(name, master, tile_blend=0.18, strength=1.6, rough_base=0.9,
          speckle=0.05, joints=None, rough=True, neutral=0.85, mid_sigma=None):
    a = to_f(Image.open(f'{SRC}/{master}'))
    a = make_tileable(a, tile_blend)
    a = delight(a, mid_sigma=mid_sigma)
    a = neutral_hue(a, neutral)
    a = add_speckle(a, speckle)
    if joints:
        a = draw_joints(a, joints)
    albedo = to_img(a).resize((2048, 2048), Image.LANCZOS)
    albedo = albedo.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=3))
    save(albedo, name)
    save(normal_map(a, strength), name + '_n', 92)
    if rough:
        save(roughness_map(a, rough_base), name + '_r')

def draw_joints(a, spacing):
    """Concrete slabs: saw-cut joints — `spacing` vertical runs and the same
    number of horizontal runs shifted a third of a slab (running bond, so
    no plus-sign repeats dead-centre on the tile), each with a gentle
    long-wave wobble, a dark trough and a pale chipped lip."""
    n = a.shape[0]
    out = a.copy()
    rng = np.random.default_rng(11)
    w = max(3, n // 240)              # the cut's half-width
    wob = ndimage.gaussian_filter(rng.normal(0, 1, n), 26)
    wob = (wob / (np.abs(wob).max() + 1e-6) * (n // 220)).astype(np.int32)
    rows = np.arange(n)

    def cut(fixed_pos, vertical):
        for d in range(-w - 2, w + 3):
            t = 1 - abs(d) / (w + 3)
            wob_d = wob if vertical else -wob
            if vertical:
                r = rows
                c = (fixed_pos + d + wob_d) % n
                band = out[r, c]
            else:
                c = (fixed_pos + d + wob_d) % n
                r = rows
                band = out[c, r]
            if abs(d) >= w - 1:
                band = np.clip(band * (1 + 0.18 * t), 0, 1)   # pale chipped lip
            else:
                band = band * (1 - 0.45 * t)                  # the dark trough
            if vertical:
                out[r, c] = band
            else:
                out[c, r] = band

    shift = int(n * 0.37 / spacing)
    for k in range(spacing):
        cut(int(n * k / spacing), True)
        cut((int(n * k / spacing) + shift) % n, False)
    return out

# ---- the set ----
build('asphalt', 'asphalt.png', tile_blend=0.16, strength=1.7, rough_base=0.88, speckle=0.06)
build('concrete', 'concrete2.png', tile_blend=0.16, strength=1.1, rough_base=0.82, speckle=0.045, joints=2)
# the sand keeps half its warmth (a beach is the one place the tint is
# allowed to be its own), and its ripple shading is flattened out of the
# albedo so the normal map can carry the relief alone
build('sand', 'sand.png', tile_blend=0.22, strength=2.6, rough=False, speckle=0.035, neutral=0.55, mid_sigma=14)

# plaster: only the normal ships (the facades paint their own albedo)
a = to_f(Image.open(f'{SRC}/plaster.png'))
a = make_tileable(a, 0.18)
a = delight(a)
save(normal_map(a, 0.55, 1024), 'plaster_n', 92)
print('done')
