import { useEffect, useRef } from 'react';

export interface PlaybackClock {
  progressMs: number;
  updatedAt: number;
  isPlaying: boolean;
}

interface BouncingBallProps {
  containerRef: React.RefObject<HTMLElement | null>;
  clockRef: React.RefObject<PlaybackClock>;
  lineStartMs: number;
  lineDurationMs: number;
  wordCount: number;
  lineKey: string;
  wordSelector: string;
  pixelStyle?: boolean;
  topOffset?: number;
  visible?: boolean;
}

interface WordPoint {
  x: number;
  y: number;
  el: HTMLElement;
  lastFill: number;
}

export function BouncingBall({
  containerRef,
  clockRef,
  lineStartMs,
  lineDurationMs,
  wordCount,
  lineKey,
  wordSelector,
  pixelStyle = false,
  topOffset = -10,
  visible = true,
}: BouncingBallProps) {
  const ballRef = useRef<HTMLSpanElement | null>(null);
  const pointsRef = useRef<WordPoint[]>([]);

  useEffect(() => {
    const measureWords = () => {
      const container = containerRef.current;
      if (!container) return;
      const nodes = container.querySelectorAll<HTMLElement>(wordSelector);
      const pts: WordPoint[] = [];
      nodes.forEach((node) => {
        pts.push({
          x: node.offsetLeft + node.offsetWidth / 2,
          y: node.offsetTop + topOffset,
          el: node,
          lastFill: -1,
        });
      });
      pointsRef.current = pts;
    };

    measureWords();
    window.addEventListener('resize', measureWords);
    const ro =
      typeof ResizeObserver !== 'undefined' && containerRef.current
        ? new ResizeObserver(measureWords)
        : null;
    if (ro && containerRef.current) {
      ro.observe(containerRef.current);
    }
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measureWords();
    });

    let rafId = 0;
    const step = () => {
      rafId = requestAnimationFrame(step);
      const pts = pointsRef.current;
      if (pts.length === 0) return;

      const clock = clockRef.current;
      const liveMs = clock.isPlaying
        ? clock.progressMs + (performance.now() - clock.updatedAt)
        : clock.progressMs;

      const span = Math.max(800, lineDurationMs * 0.82);
      const elapsed = Math.max(0, liveMs - lineStartMs);
      const progress = Math.min(1, elapsed / span);
      const count = Math.min(pts.length, Math.max(1, wordCount));

      // Continuous float position along the words [0 .. count]
      const rawFloat = progress * count;
      const wordFloat = Math.min(count - 1, rawFloat);
      const i = Math.floor(wordFloat);
      const next = Math.min(count - 1, i + 1);
      const f = wordFloat - i;

      // Drive 60+ FPS liquid fill (--word-fill) only when percentage actually changes
      const activeFill = i === count - 1 ? Math.min(1, rawFloat - i) : f;
      for (let k = 0; k < count; k++) {
        const fillPct = k < i ? 100 : k > i ? 0 : Math.round(activeFill * 100);
        if (pts[k].lastFill !== fillPct) {
          pts[k].lastFill = fillPct;
          pts[k].el.style.setProperty('--word-fill', `${fillPct}%`);
        }
      }

      const el = ballRef.current;
      if (!el || !visible) return;

      const p0 = pts[i];
      const p1 = pts[next];

      const x = p0.x + (p1.x - p0.x) * f;
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const arcHeight = i === next ? 0 : Math.min(46, Math.max(22, dist * 0.22));
      const arc = 4 * f * (1 - f) * arcHeight;
      const y = p0.y + (p1.y - p0.y) * f - arc;

      const edgeDist = Math.min(f, 1 - f);
      const squash = i === next ? 0 : Math.pow(Math.max(0, 1 - edgeDist * 6.5), 2);
      const apex = i === next ? 0 : 4 * f * (1 - f);
      const scaleX = 1 + squash * 0.24 - apex * 0.1;
      const scaleY = 1 - squash * 0.22 + apex * 0.14;

      el.style.opacity = '1';
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
    };

    rafId = requestAnimationFrame(step);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      window.removeEventListener('resize', measureWords);
    };
  }, [
    clockRef,
    containerRef,
    lineDurationMs,
    lineKey,
    lineStartMs,
    pixelStyle,
    topOffset,
    visible,
    wordCount,
    wordSelector,
  ]);

  if (!visible) return null;

  return (
    <span
      ref={ballRef}
      className={`bouncing-ball ${pixelStyle ? 'is-pixel-ball' : ''}`}
      style={{ opacity: 0 }}
      aria-hidden="true"
    >
      <span className="bouncing-ball-dot" />
    </span>
  );
}
