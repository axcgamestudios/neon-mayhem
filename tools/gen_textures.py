#!/usr/bin/env python3
"""Generate the game's ground/facade texture set.

Authors every map at 4096x4096 (the 4K masters) and writes the shipped
sizes: 2048 albedo / 1024 normal + roughness. Everything is tileable on
both axes (wrapped noise lattices, wrapped strokes), neutral in hue so
the engine's vertex tints still decide the color of a street, and PBR
honest: normals derived from the same height field the albedo shades.

Set:
  asphalt  - roads: aggregate speckle, tar snakes, patches, cracks, wear
  concrete - sidewalks: slabs, seams, spall, stains
  sand     - beach: grain, ripples, shell flecks
  plaster  - facades: stucco grain for the buildings' normal map

Outputs to media/textures/ as JPEG (albedo q86, normal q92 to keep the
vector field clean, roughness q86).
"""
import os
import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "media", "textures"))
os.makedirs(OUT, exist_ok=True)
MASTER = 4096          # authored resolution (the 4K masters)
SHIP_ALBEDO = 2048     # shipped albedo size
SHIP_AUX = 1024        # shipped normal/roughness size
RNG = np.random.default_rng(20260406)


# ---------------------------------------------------------------- noise kit
def lattice(n, rng):
    return rng.random((n, n))


def value_noise(size, n, rng, octaves=4, persistence=0.5):
    """Tileable fractal value noise in [0,1]."""
    total = np.zeros((size, size), dtype=np.float64)
    amp = 1.0
    freq = n
    norm = 0.0
    for _ in range(octaves):
        lat = lattice(freq, rng)
        ys = np.linspace(0, freq, size, endpoint=False)
        xs = np.linspace(0, freq, size, endpoint=False)
        yi = np.floor(ys).astype(int) % freq
        xi = np.floor(xs).astype(int) % freq
        yf = ys - np.floor(ys)
        xf = xs - np.floor(xs)
        sy = yf * yf * (3 - 2 * yf)
        sx = xf * xf * (3 - 2 * xf)
        a = lat[np.ix_(yi, xi)]
        b = lat[np.ix_(yi, (xi + 1) % freq)]
        c = lat[np.ix_((yi + 1) % freq, xi)]
        d = lat[np.ix_((yi + 1) % freq, (xi + 1) % freq)]
        row = a + (b - a) * sx[:, None]
        row2 = c + (d - c) * sx[:, None]
        total += (row + (row2 - row) * sy[None, :]) * amp
        norm += amp
        amp *= persistence
        freq *= 2
    return total / norm


def wrap_strokes(size, strokes=90, length=0.30, width=3, rng=None):
    """Long wrapped dark strokes for tar snakes / cracks. Returns a
    [0..1] field where 1 = untouched, lower = painted."""
    f = np.ones((size, size))
    for _ in range(strokes):
        x = rng.integers(0, size)
        y = rng.integers(0, size)
        ang = rng.uniform(0, 2 * np.pi)
        n = int(length * size / 8)
        step = max(1.0, size / 2048.0)
        dx = np.cos(ang) * step
        dy = np.sin(ang) * step
        wob = rng.uniform(-0.35, 0.35, n).cumsum()
        px, py = float(x), float(y)
        for i in range(n):
            px = (px + dx + wob[i] * 0.5) % size
            py = (py + dy + wob[i] * 0.4) % size
            v = 1.0 - (i / n) * rng.uniform(0.2, 0.9)
            r = width / 2
            for o in range(-width // 2, width // 2 + 1):
                for o2 in range(-width // 2, width // 2 + 1):
                    if o * o + o2 * o2 <= r * r:
                        f[int(py + o) % size, int(px + o2) % size] *= (1.0 - 0.55 * v)
    return f


def height_to_normal(h, strength=2.0):
    sx = np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)
    sy = np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)
    n = np.dstack([-sx * strength, -sy * strength, np.ones_like(h) * 2.0])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n * 0.5 + 0.5


def save_arr(arr, name, size, q):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
    if im.size[0] != size:
        im = im.resize((size, size), Image.LANCZOS)
    path = os.path.join(OUT, name)
    im.save(path, 'JPEG', quality=q, optimize=True)
    print(f"  {name:24s} {im.size[0]}x{im.size[1]}  {os.path.getsize(path)/1024:7.0f} KB")


# ------------------------------------------------------------------ ASPHALT
def gen_asphalt():
    print("asphalt")
    S = MASTER
    patch = value_noise(S, 6, RNG, octaves=3)
    agg = value_noise(S, 96, RNG, octaves=2, persistence=0.6)
    grain = RNG.random((S, S))
    chips = (value_noise(S, 220, RNG, octaves=1) > 0.86).astype(np.float64)
    chips = np.maximum(chips, (grain > 0.99).astype(np.float64) * 0.7)

    h = agg * 0.55 + patch * 0.25 + grain * 0.05 + chips * 0.35
    h = (h - h.min()) / (h.max() - h.min())

    tar = wrap_strokes(S, strokes=22, length=0.45, width=4, rng=RNG)
    base = 0.42 + patch * 0.15
    alb = base + (agg - 0.5) * 0.22 + (grain - 0.5) * 0.10
    alb = alb * (0.95 + chips * 0.25)
    alb *= (0.74 + tar * 0.26)
    ys = np.linspace(0, 1, S, endpoint=False)
    wear = 1.0 - 0.05 * np.exp(-((ys - 0.33) ** 2) / 0.004) - 0.05 * np.exp(-((ys - 0.67) ** 2) / 0.004)
    alb *= wear[:, None]
    albedo = np.dstack([alb, alb * 0.995, alb * 0.985])

    rough = 0.86 + (patch - 0.5) * 0.10 - (1.0 - tar) * 0.32 - (1.0 - wear)[:, None] * 0.16
    rough = np.clip(rough, 0.18, 0.98)

    save_arr(albedo, 'asphalt.jpg', SHIP_ALBEDO, 86)
    save_arr(height_to_normal(h, strength=1.4), 'asphalt_n.jpg', SHIP_AUX, 92)
    save_arr(np.dstack([rough] * 3), 'asphalt_r.jpg', SHIP_AUX, 86)


# ---------------------------------------------------------------- CONCRETE
def gen_concrete():
    print("concrete")
    S = MASTER
    mottle = value_noise(S, 5, RNG, octaves=4)
    fine = value_noise(S, 140, RNG, octaves=2, persistence=0.55)
    grain = RNG.random((S, S))
    stain = value_noise(S, 3, RNG, octaves=2)

    seam = np.ones((S, S))
    nslab = 4
    for k in range(nslab):
        pos = int(S * k / nslab)
        w = max(2, S // 340)
        for o in range(-w, w + 1):
            seam[(pos + o) % S, :] = 0.0
            seam[:, (pos + o) % S] = 0.0
    seam_img = Image.fromarray((seam * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(S // 900))
    seam = np.asarray(seam_img).astype(np.float64) / 255.0

    h = (fine * 0.4 + mottle * 0.3 + grain * 0.06) * (0.55 + seam * 0.45) - (1.0 - seam) * 0.6
    alb = 0.54 + mottle * 0.19 + (fine - 0.5) * 0.16 + (grain - 0.5) * 0.07
    alb = alb * (0.55 + seam * 0.45) + seam * 0.02
    alb -= np.clip(stain - 0.72, 0, 1) * 0.18
    albedo = np.dstack([alb, alb, alb * 0.997])

    rough = 0.78 + (mottle - 0.5) * 0.12 - np.clip(stain - 0.7, 0, 1) * 0.18
    rough = np.clip(rough, 0.5, 0.95)

    save_arr(albedo, 'concrete.jpg', SHIP_ALBEDO, 86)
    save_arr(height_to_normal(h, strength=1.1), 'concrete_n.jpg', SHIP_AUX, 92)
    save_arr(np.dstack([rough] * 3), 'concrete_r.jpg', SHIP_AUX, 86)


# -------------------------------------------------------------------- SAND
def gen_sand():
    print("sand")
    S = MASTER
    ripple = value_noise(S, 26, RNG, octaves=2, persistence=0.5)
    grainfield = value_noise(S, 300, RNG, octaves=1)
    grain = RNG.random((S, S))
    band = value_noise(S, 4, RNG, octaves=2)

    h = ripple * 0.5 + grainfield * 0.3 + grain * 0.08
    alb = 0.68 + (ripple - 0.5) * 0.09 + (grainfield - 0.5) * 0.11 + (grain - 0.5) * 0.09
    alb += (grain > 0.993).astype(np.float64) * 0.20
    alb -= np.clip(band - 0.6, 0, 1) * 0.07
    albedo = np.dstack([alb, alb * 0.965, alb * 0.88])

    save_arr(albedo, 'sand.jpg', SHIP_ALBEDO, 86)
    save_arr(height_to_normal(h, strength=0.9), 'sand_n.jpg', SHIP_AUX, 92)


# ----------------------------------------------------------------- PLASTER
def gen_plaster():
    print("plaster (facade normal)")
    S = 1024
    trowel = value_noise(S, 40, RNG, octaves=3, persistence=0.55)
    fine = value_noise(S, 200, RNG, octaves=2, persistence=0.5)
    h = trowel * 0.6 + fine * 0.4
    save_arr(height_to_normal(h, strength=0.7), 'plaster_n.jpg', S, 92)


if __name__ == '__main__':
    gen_asphalt()
    gen_concrete()
    gen_sand()
    gen_plaster()
    print("done ->", OUT)
