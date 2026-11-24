import type { PalettePresetId, ResolvedBiome, TrackPalette } from '../types';

export const DEFAULT_PALETTE: TrackPalette = {
  primary: '#38bdf8',
  secondary: '#f472b6',
  accent: '#fde047',
  background: '#090d16',
};

export const PALETTE_PRESETS: Record<Exclude<PalettePresetId, 'cover'>, TrackPalette> = {
  gameboy: {
    primary: '#8bac0f',
    secondary: '#306230',
    accent: '#9bbc0f',
    background: '#0f380f',
  },
  sunset: {
    primary: '#fb7185',
    secondary: '#7c3aed',
    accent: '#fde047',
    background: '#120821',
  },
  cyber: {
    primary: '#00f5d4',
    secondary: '#3b82f6',
    accent: '#f0fdfa',
    background: '#050b14',
  },
  crimson: {
    primary: '#ef4444',
    secondary: '#991b1b',
    accent: '#fbbf24',
    background: '#120406',
  },
};

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function getSaturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (1 - Math.abs(2 * l - 1));
}

function getLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16);
  if (Number.isNaN(num)) return [128, 128, 128];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function liftColorForDarkBg(hex: string, minLum: number): string {
  const [r, g, b] = hexToRgb(hex);
  const lum = getLuminance(r, g, b);
  if (lum >= minLum) return hex;
  const boost = Math.min(0.78, (minLum - lum) / Math.max(0.08, 1 - lum));
  return rgbToHex(
    r + (255 - r) * boost,
    g + (255 - g) * boost,
    b + (255 - b) * boost
  );
}

/**
 * Ensures extracted or preset palettes keep crisp readability for lyrics & HUD
 * even on all-white, neon-yellow, or pitch-black album covers.
 */
export function ensureReadablePalette(palette: TrackPalette): TrackPalette {
  const [br, bg, bb] = hexToRgb(palette.background);
  const bgLum = getLuminance(br, bg, bb);
  const safeBg =
    bgLum > 0.14
      ? rgbToHex(br * 0.22, bg * 0.22, bb * 0.26 + 6)
      : palette.background;

  return {
    primary: liftColorForDarkBg(palette.primary, 0.34),
    secondary: liftColorForDarkBg(palette.secondary, 0.26),
    accent: liftColorForDarkBg(palette.accent, 0.56),
    background: safeBg,
  };
}

/**
 * Ensures the solid inverted backdrop in the Type scene stays rich & vivid
 * (like the reference video's pink/amber frames) even on desaturated album art.
 */
export function boostVibrantColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  } else {
    // Pure gray cover -> tint to crisp violet-pink accent
    h = 0.84;
    s = 0.68;
  }

  s = Math.max(0.62, Math.min(0.88, s * 1.18));
  l = Math.max(0.52, Math.min(0.68, l));

  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgbToHex(
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255
  );
}

const paletteCache = new Map<string, TrackPalette>();

/**
 * Samples an album cover on an offscreen canvas and extracts a 4-color palette
 * weighted toward saturated, high-contrast tones for 3D lighting.
 */
export async function extractPaletteFromImage(imageUrl: string | null): Promise<TrackPalette> {
  if (!imageUrl) return DEFAULT_PALETTE;
  const cached = paletteCache.get(imageUrl);
  if (cached) return cached;

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const size = 48;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(DEFAULT_PALETTE);
          return;
        }

        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        const buckets = new Map<string, { r: number; g: number; b: number; weight: number }>();

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 128) continue;

          const lum = getLuminance(r, g, b);
          const sat = getSaturation(r, g, b);
          // Quantize into 24-step buckets so similar shades merge
          const key = `${Math.round(r / 24)}-${Math.round(g / 24)}-${Math.round(b / 24)}`;
          const score = 1 + sat * 4 + (lum > 0.15 && lum < 0.85 ? 1.5 : 0);

          const prev = buckets.get(key);
          if (prev) {
            prev.r += r * score;
            prev.g += g * score;
            prev.b += b * score;
            prev.weight += score;
          } else {
            buckets.set(key, { r: r * score, g: g * score, b: b * score, weight: score });
          }
        }

        const sorted = Array.from(buckets.values())
          .map((b) => {
            const r = b.r / b.weight;
            const g = b.g / b.weight;
            const bl = b.b / b.weight;
            return {
              r,
              g,
              b: bl,
              sat: getSaturation(r, g, bl),
              lum: getLuminance(r, g, bl),
              weight: b.weight,
            };
          })
          .sort((a, b) => b.weight * (0.5 + b.sat) - a.weight * (0.5 + a.sat));

        if (sorted.length === 0) {
          resolve(DEFAULT_PALETTE);
          return;
        }

        const primary = sorted[0];
        // Pick secondary with distinct hue/brightness from primary
        const secondary =
          sorted.find((c) => Math.hypot(c.r - primary.r, c.g - primary.g, c.b - primary.b) > 70) ??
          sorted[Math.min(1, sorted.length - 1)];

        const accent =
          sorted.find(
            (c) =>
              c.lum > 0.35 &&
              Math.hypot(c.r - primary.r, c.g - primary.g, c.b - primary.b) > 95
          ) ?? secondary;

        // Deep background derived from primary so the 3D scene stays cohesive
        const bg = rgbToHex(primary.r * 0.1, primary.g * 0.1, primary.b * 0.14 + 8);

        const palette = ensureReadablePalette({
          primary: rgbToHex(primary.r, primary.g, primary.b),
          secondary: rgbToHex(secondary.r, secondary.g, secondary.b),
          accent: rgbToHex(accent.r, accent.g, accent.b),
          background: bg,
        });
        paletteCache.set(imageUrl, palette);
        resolve(palette);
      } catch {
        resolve(DEFAULT_PALETTE);
      }
    };

    img.onerror = () => resolve(DEFAULT_PALETTE);
    img.src = imageUrl;
  });
}

export function resolveBiomeForGenres(genres: string[]): ResolvedBiome {
  const joined = genres.join(' ').toLowerCase();

  if (/ambient|lo-fi|lofi|chill|indie|pop|r&b/.test(joined)) {
    return 'pixel-horizon';
  }
  if (/rock|metal|hyperpop|dubstep|dnb|trap/.test(joined)) {
    return 'pixel-plasma';
  }
  if (/synth|electro|techno|house|phonk/.test(joined)) {
    return 'pixel-tunnel';
  }
  return 'pixel-kaleido';
}
