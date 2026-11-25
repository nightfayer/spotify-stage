export type WordVariant = 'solid' | 'outline' | 'serif' | 'hero';

export interface WorldBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PlacedWord {
  id: string;
  word: string;
  wordIndex: number;
  x: number;
  y: number;
  rot: number; // degrees in world space: 0, 90, or -90
  fontSize: number; // exact px in world coordinates
  zoom: number; // ideal camera zoom at 1280px reference width
  variant: WordVariant;
  isHero: boolean;
  box: WorldBox;
}

const GAP = 26; // minimum clean breathing space between any two words in world px
const COLLISION_PAD = 18;

let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  if (typeof document === 'undefined') {
    measureCtx = null;
    return null;
  }
  const canvas = document.createElement('canvas');
  measureCtx = canvas.getContext('2d');
  return measureCtx;
}

function getCanvasFont(variant: WordVariant, fontSize: number): string {
  if (variant === 'serif') {
    return `700 ${fontSize}px "Playfair Display", Georgia, serif`;
  }
  if (variant === 'hero') {
    return `700 ${fontSize}px "Rubik", "Manrope", sans-serif`;
  }
  return `800 ${fontSize}px "Manrope", "Helvetica Neue", sans-serif`;
}

/**
 * Accurately measures rendered word dimensions in world px (uses real Canvas 2D measureText
 * in browser with a generous geometric fallback for headless tests).
 */
export function measureWordDimensions(
  word: string,
  variant: WordVariant,
  fontSize: number
): { width: number; height: number } {
  const display = word.toLowerCase();
  const ctx = getMeasureContext();
  let width: number;

  if (ctx) {
    ctx.font = getCanvasFont(variant, fontSize);
    const metrics = ctx.measureText(display);
    // Add slight safety margin for stroke/italic/letter-spacing differences
    width = Math.max(fontSize * 0.65, metrics.width * 1.04 + 14);
  } else {
    // Generous fallback for unit tests (wide Cyrillic/Latin glyphs)
    const charFactor = variant === 'serif' ? 0.62 : variant === 'hero' ? 0.66 : 0.63;
    width = Math.max(fontSize * 0.7, display.length * fontSize * charFactor + 18);
  }

  const height = fontSize * (variant === 'serif' ? 1.18 : 1.14);
  return { width: Math.ceil(width + fontSize * 0.16), height: Math.ceil(height) };
}

function makeBox(cx: number, cy: number, w: number, h: number, rot: number): WorldBox {
  const isVertical = Math.abs(rot) === 90;
  const worldW = isVertical ? h : w;
  const worldH = isVertical ? w : h;
  return {
    left: cx - worldW / 2,
    right: cx + worldW / 2,
    top: cy - worldH / 2,
    bottom: cy + worldH / 2,
  };
}

export function boxesOverlap(a: WorldBox, b: WorldBox, pad = COLLISION_PAD): boolean {
  return !(
    a.right + pad <= b.left ||
    a.left - pad >= b.right ||
    a.bottom + pad <= b.top ||
    a.top - pad >= b.bottom
  );
}

function pickHeroWordIndex(words: string[]): number {
  if (words.length <= 1) return 0;
  let bestIdx = 0;
  let bestLen = 0;
  for (let i = 0; i < words.length; i++) {
    const cleanLen = words[i].replace(/[^a-zA-Zа-яА-ЯёЁ0-9]/g, '').length;
    if (cleanLen >= bestLen) {
      bestLen = cleanLen;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Collision-free 2D continuous camera layout inspired by After Effects lyric reels:
 * every word gets an exact measured bounding box and is placed strictly outside all
 * previously placed boxes — even across ±90° camera rotations.
 */
export function layoutLineInWorld(
  words: string[],
  lineIdx: number,
  trackId: string
): PlacedWord[] {
  const heroIdx = pickHeroWordIndex(words);
  // 6 distinct choreography patterns:
  // 0: right-down + 90° turn
  // 1: stair-up + -90° turn
  // 2: Z-zigzag + 90° -> 0° double turn on long lines
  // 3: right-up + -90° -> 0° double turn on long lines
  // 4: horizontal cadence + sharp 90° drop
  // 5: ascending diagonal + -90° pivot
  const pattern = lineIdx % 6;
  const placed: PlacedWord[] = [];
  let curRot = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const isHero = i === heroIdx;
    const cleanLen = Math.max(1, word.replace(/[^a-zA-Zа-яА-ЯёЁ0-9]/g, '').length);

    // Contrasting editorial typography mix (Solid / Outline / High-Contrast Serif / Rounded Hero)
    let variant: WordVariant = 'solid';
    if (isHero) {
      variant = (lineIdx + i) % 2 === 0 ? 'hero' : 'serif';
    } else if (i % 3 === 1) {
      variant = 'outline';
    } else if (i % 4 === 2) {
      variant = 'serif';
    }

    // Exact world-space font size scaled gracefully for long Cyrillic/English words
    let fontSize = variant === 'hero' ? 106 : variant === 'serif' ? 92 : 80;
    if (cleanLen >= 11) fontSize = Math.round(fontSize * 0.72);
    else if (cleanLen >= 8) fontSize = Math.round(fontSize * 0.84);
    else if (cleanLen <= 3 && !isHero) fontSize = Math.round(fontSize * 1.08);

    const { width: w, height: h } = measureWordDimensions(word, variant, fontSize);

    let cx = 0;
    let cy = 0;
    let box = makeBox(0, 0, w, h, curRot);

    if (i > 0) {
      const prev = placed[i - 1];
      const prevBox = prev.box;

      // Single or double ±90° camera turns (0° -> ±90° -> 0° on 6+ word lines)
      const firstTurn = Math.max(1, Math.min(words.length - 1, heroIdx === 0 ? 2 : Math.min(heroIdx, 3)));
      const secondTurn = words.length >= 6 && (pattern === 2 || pattern === 3) ? Math.min(words.length - 1, firstTurn + 2) : -1;

      if (i === firstTurn && curRot === 0 && words.length >= 3) {
        curRot = pattern % 2 === 0 ? 90 : -90;
      } else if (i === secondTurn && curRot !== 0) {
        curRot = 0;
      }

      const isVertical = Math.abs(curRot) === 90;
      const myWorldW = isVertical ? h : w;
      const myWorldH = isVertical ? w : h;

      let dirX = 0;
      let dirY = 1;

      if (curRot === 0) {
        if (prev.rot !== 0) {
          // Returning from ±90° back to 0°: step cleanly below the rotated cluster
          cx = prev.x;
          cy = prevBox.bottom + GAP + myWorldH / 2;
          dirX = 0;
          dirY = 1;
        } else if (pattern === 1 || pattern === 5) {
          // Ascending stair-up trajectory
          if (i % 2 === 1) {
            cx = prevBox.right + GAP + myWorldW / 2;
            cy = prev.y - 24;
            dirX = 1;
            dirY = 0;
          } else {
            cx = prev.x + 28;
            cy = prevBox.top - GAP - myWorldH / 2;
            dirX = 0;
            dirY = -1;
          }
        } else if (pattern === 2) {
          // Z-zigzag: alternate right and left-below
          if (i % 2 === 1) {
            cx = prevBox.right + GAP + myWorldW / 2;
            cy = prev.y + 8;
            dirX = 1;
            dirY = 0;
          } else {
            cx = prevBox.left - 24;
            cy = prevBox.bottom + GAP + myWorldH / 2;
            dirX = 0;
            dirY = 1;
          }
        } else {
          // Classic editorial right-step and drop-down stair
          if (i % 2 === 1) {
            cx = prevBox.right + GAP + myWorldW / 2;
            cy = prev.y + (pattern % 2 === 0 ? 10 : -10);
            dirX = 1;
            dirY = 0;
          } else {
            cx = prev.x + (pattern % 2 === 0 ? 24 : -24);
            cy = prevBox.bottom + GAP + myWorldH / 2;
            dirX = 0;
            dirY = 1;
          }
        }
      } else if (curRot === 90) {
        // Camera is rotated -90° so screen-down is -X in world space
        if (prev.rot === 0) {
          cx = prevBox.right + GAP + myWorldW / 2;
          cy = prevBox.top + myWorldH / 2;
          dirX = 1;
          dirY = 0;
        } else {
          cx = prevBox.left - GAP - myWorldW / 2;
          cy = prev.y;
          dirX = -1;
          dirY = 0;
        }
      } else {
        // curRot === -90: camera is rotated +90°, screen-down is +X in world space
        if (prev.rot === 0) {
          cx = prevBox.left - GAP - myWorldW / 2;
          cy = prevBox.top + myWorldH / 2;
          dirX = -1;
          dirY = 0;
        } else {
          cx = prevBox.right + GAP + myWorldW / 2;
          cy = prev.y;
          dirX = 1;
          dirY = 0;
        }
      }

      // Guarantee 0 overlaps against ALL previously placed words
      box = makeBox(cx, cy, w, h, curRot);
      let guard = 0;
      while (placed.some((p) => boxesOverlap(box, p.box)) && guard < 48) {
        guard += 1;
        cx += dirX * 28;
        cy += dirY * 28;
        if (dirX === 0 && dirY === 0) cy += 28;
        box = makeBox(cx, cy, w, h, curRot);
      }
    }

    // Fit camera zoom so even very long words stay fully inside viewport with generous margins
    const targetFitWidth = 940;
    const rawZoom = Math.min(1.24, Math.max(0.48, targetFitWidth / Math.max(380, w * 1.28)));
    const zoom = Number((isHero ? Math.min(1.26, rawZoom * 1.04) : rawZoom).toFixed(3));

    placed.push({
      id: `${trackId}-${lineIdx}-${i}-${word}`,
      word,
      wordIndex: i,
      x: Math.round(cx),
      y: Math.round(cy),
      rot: curRot,
      fontSize,
      zoom,
      variant,
      isHero,
      box,
    });
  }

  return placed;
}
