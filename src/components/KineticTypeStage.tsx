import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { layoutLineInWorld, type WordVariant } from '../lib/kineticLayout';
import type { ActiveLyricState } from '../lib/lyrics';
import { boostVibrantColor } from '../lib/palette';
import type { FontStyleMode, TrackState } from '../types';
import type { PlaybackClock } from './BouncingBall';

interface KineticTypeStageProps {
  track: TrackState;
  activeLyric: ActiveLyricState | null;
  isInterlude: boolean;
  beatRef: React.RefObject<HTMLDivElement | null>;
  clockRef: React.RefObject<PlaybackClock>;
  spectrumRef: React.RefObject<Uint8Array | null>;
  showBall: boolean;
  fontStyle: FontStyleMode;
  lyricOffsetMs: number;
}

function getViewportScale(): number {
  if (typeof window === 'undefined') return 1;
  const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  return Number(Math.min(1.3, Math.max(0.45, scale)).toFixed(3));
}

export const KineticTypeStage = memo(function KineticTypeStage({
  track,
  activeLyric,
  isInterlude,
  beatRef,
  clockRef,
  spectrumRef,
  showBall,
  fontStyle,
  lyricOffsetMs,
}: KineticTypeStageProps) {
  void showBall;
  void lyricOffsetMs;
  const topProgressFillRef = useRef<HTMLDivElement | null>(null);
  const eqBarRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [fontsLoadedTick, setFontsLoadedTick] = useState(0);
  const [viewportScale, setViewportScale] = useState(getViewportScale);

  // Drive live 16-bar mirrored FFT spectrum ribbon during instrumental interludes (0 cost during lyrics)
  useEffect(() => {
    if (!isInterlude) return;
    let rafId = 0;
    const step = () => {
      rafId = requestAnimationFrame(step);
      if (document.hidden) return;
      const spec = spectrumRef.current;
      if (!spec || spec.length < 64) return;
      for (let i = 0; i < 16; i++) {
        const bar = eqBarRefs.current[i];
        if (!bar) continue;
        // Symmetrical mirror: center bars = bass/low-mid, edges = treble
        const distFromCenter = Math.abs(i - 7.5) / 7.5;
        const binIdx = Math.min(63, Math.floor(distFromCenter * 44));
        const amp = spec[binIdx] / 255;
        bar.style.transform = `scaleY(${(0.14 + amp * 1.35).toFixed(3)})`;
      }
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [isInterlude, spectrumRef]);

  // Re-measure word widths once web fonts (Manrope / Playfair / Rubik) finish loading
  useEffect(() => {
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) setFontsLoadedTick((n) => n + 1);
    });
    const onResize = () => setViewportScale(getViewportScale());
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // Smooth 60+ FPS GPU-composited top progress bar driven directly from clockRef
  useEffect(() => {
    let rafId = 0;
    let lastRatioStr = '';
    const duration = Math.max(1, track.durationMs);
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (document.hidden) return;
      const fill = topProgressFillRef.current;
      if (!fill) return;
      const clock = clockRef.current;
      const liveMs = clock.isPlaying
        ? clock.progressMs + (performance.now() - clock.updatedAt)
        : clock.progressMs;
      const ratioStr = Math.min(1, Math.max(0, liveMs / duration)).toFixed(4);
      if (ratioStr !== lastRatioStr) {
        lastRatioStr = ratioStr;
        fill.style.transform = `scaleX(${ratioStr})`;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [clockRef, track.durationMs]);

  const lineIndex = activeLyric ? activeLyric.index : 0;
  const words = useMemo(() => {
    if (activeLyric && activeLyric.words.length > 0) return activeLyric.words;
    return track.title.split(/\s+/).filter(Boolean);
  }, [activeLyric, track.title]);

  const placedWords = useMemo(() => {
    void fontsLoadedTick;
    return layoutLineInWorld(words, lineIndex, track.id);
  }, [fontsLoadedTick, lineIndex, track.id, words]);

  const activeWordIdx = activeLyric
    ? Math.min(placedWords.length - 1, Math.max(0, activeLyric.activeWordIndex))
    : placedWords.length - 1;

  const focusWord = placedWords[activeWordIdx] ?? placedWords[0];

  // Seamless cross-line continuity: keep the outgoing line's last word whipping away for 250ms
  const lineKey = `${track.id}-${lineIndex}`;
  const [exitingEcho, setExitingEcho] = useState<{
    key: string;
    word: string;
    variant: WordVariant;
    fontSize: number;
  } | null>(null);
  const prevLineRef = useRef<{
    key: string;
    word: string;
    variant: WordVariant;
    fontSize: number;
  }>({
    key: lineKey,
    word: focusWord?.word ?? '',
    variant: focusWord?.variant ?? 'solid',
    fontSize: focusWord?.fontSize ?? 80,
  });

  useEffect(() => {
    if (prevLineRef.current.key !== lineKey) {
      const leaving = prevLineRef.current;
      if (leaving.word) {
        setExitingEcho(leaving);
        const t = window.setTimeout(() => setExitingEcho(null), 260);
        prevLineRef.current = {
          key: lineKey,
          word: focusWord?.word ?? '',
          variant: focusWord?.variant ?? 'solid',
          fontSize: focusWord?.fontSize ?? 80,
        };
        return () => window.clearTimeout(t);
      }
    }
    if (focusWord) {
      prevLineRef.current = {
        key: lineKey,
        word: focusWord.word,
        variant: focusWord.variant,
        fontSize: focusWord.fontSize,
      };
    }
  }, [focusWord, lineKey]);

  const vibrantPrimary = useMemo(
    () => boostVibrantColor(track.palette.primary),
    [track.palette.primary]
  );

  // High-contrast After Effects color inversion flip every 2 lines (Dark/Color <-> Color/Black)
  const isInverted = !isInterlude && Math.floor(lineIndex / 2) % 2 === 1;
  const isPhraseEndPullBack = placedWords.length >= 3 && activeWordIdx === placedWords.length - 1;
  const isShortHook = placedWords.length <= 2;

  // Trigger razor-sharp AE diagonal shutter wipe whenever Dark <-> Color inversion flips
  const prevInvertedRef = useRef(isInverted);
  const [wipeTick, setWipeTick] = useState(0);
  useEffect(() => {
    if (prevInvertedRef.current !== isInverted) {
      prevInvertedRef.current = isInverted;
      setWipeTick((n) => n + 1);
    }
  }, [isInverted]);

  // Pick at most ONE solid non-hero accent word per line for the editorial Highlight Marker Sweep
  const highlightWordIdx = useMemo(() => {
    if (placedWords.length < 3) return -1;
    const punctIdx = placedWords.findIndex(
      (w) => !w.isHero && w.variant === 'solid' && /[!?]$/.test(w.word)
    );
    if (punctIdx >= 0) return punctIdx;
    const candidate = placedWords.find((w) => !w.isHero && w.variant === 'solid' && w.wordIndex > 0);
    return candidate ? candidate.wordIndex : -1;
  }, [placedWords]);

  const cameraStyle = useMemo(() => {
    const baseZoom = focusWord ? focusWord.zoom * viewportScale : viewportScale;
    const finalZoom = isPhraseEndPullBack ? baseZoom * 0.88 : baseZoom;
    return {
      '--cam-x': focusWord ? focusWord.x : 0,
      '--cam-y': focusWord ? focusWord.y : 0,
      '--cam-rot': focusWord ? focusWord.rot : 0,
      '--cam-zoom': Number(finalZoom.toFixed(3)),
    } as React.CSSProperties;
  }, [focusWord, isPhraseEndPullBack, viewportScale]);

  const lineNumLabel = String(lineIndex + 1).padStart(2, '0');

  return (
    <div
      ref={beatRef}
      className={`reels-type-stage ae-canvas-stage font-${fontStyle} ${isInverted ? 'is-inverted' : 'is-dark'}`}
      style={
        {
          '--reel-primary': vibrantPrimary,
          '--reel-secondary': track.palette.secondary,
          '--reel-accent': track.palette.accent,
          '--reel-bg': track.palette.background,
        } as React.CSSProperties
      }
    >
      {/* Razor-thin top progress hairline */}
      <div className="reels-top-progress" aria-hidden="true">
        <div ref={topProgressFillRef} className="reels-top-progress-fill" />
      </div>

      {/* AE Diagonal Shutter Wipe Cut on Dark <-> Color inversion flips */}
      {wipeTick > 0 && <div key={`wipe-${wipeTick}`} className="ae-color-wipe" aria-hidden="true" />}

      {/* Subtle Editorial Viewfinder Crosshairs & Parallax Giant Line Number */}
      {!isInterlude && (
        <div className="ae-parallax-backdrop" style={cameraStyle} aria-hidden="true">
          <span className="ae-watermark-num">{lineNumLabel}</span>
          <span className="ae-viewfinder-mark top-left">+</span>
          <span className="ae-viewfinder-mark top-right">LN // {lineNumLabel}</span>
          <span className="ae-viewfinder-mark bottom-left">+</span>
          <span className="ae-viewfinder-mark bottom-right">+</span>
        </div>
      )}

      {/* Signature Intro / Interlude Pulsing Circle + Live 16-Bar FFT Ribbon OR Continuous 2D Camera */}
      {isInterlude ? (
        <div className="ae-intro-circle-wrap" aria-hidden="true">
          <span className="ae-intro-circle" />
          <div className="ae-interlude-eq">
            {Array.from({ length: 16 }).map((_, idx) => (
              <span
                key={idx}
                ref={(el) => {
                  eqBarRefs.current[idx] = el;
                }}
                className="ae-interlude-bar"
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="ae-camera-viewport" key={`line-${lineKey}`}>
          {exitingEcho && (
            <div
              className={`ae-line-echo variant-${exitingEcho.variant}`}
              key={`echo-${exitingEcho.key}`}
              style={{ '--wsize': `${exitingEcho.fontSize}px` } as React.CSSProperties}
              aria-hidden="true"
            >
              <span className="ae-world-word-text">{exitingEcho.word}</span>
            </div>
          )}
          <div className="ae-camera-rig" style={cameraStyle}>
            {placedWords.map((item) => {
              const isActive = item.wordIndex === activeWordIdx;
              const age = activeWordIdx - item.wordIndex;
              const hasPunctuation = /[!?]$/.test(item.word);
              const hasHighlight = item.wordIndex === highlightWordIdx;
              const useLetterSplit = item.isHero && item.word.length >= 2 && item.word.length <= 14;
              const showEchoClones = isActive && (item.isHero || isShortHook);
              const stateCls = isActive
                ? 'is-active'
                : age === 1
                  ? 'is-spoken'
                  : age > 1
                    ? 'is-spoken-far'
                    : 'is-upcoming';
              return (
                <div
                  key={item.id}
                  className={`ae-world-word variant-${item.variant} ${stateCls} ${hasPunctuation ? 'has-accent-mark' : ''} ${hasHighlight ? 'has-highlight-sweep' : ''} ${useLetterSplit ? 'has-letter-split' : ''}`}
                  style={
                    {
                      '--wx': `${item.x}px`,
                      '--wy': `${item.y}px`,
                      '--wrot': `${item.rot}deg`,
                      '--wsize': `${item.fontSize}px`,
                    } as React.CSSProperties
                  }
                >
                  {isShortHook && isActive && (
                    <span className="ae-hook-ring" key={`ring-${item.id}`} aria-hidden="true" />
                  )}
                  {showEchoClones && (
                    <>
                      <span className="ae-word-clone clone-up" key={`cu-${item.id}`} aria-hidden="true">
                        {item.word}
                      </span>
                      <span className="ae-word-clone clone-down" key={`cd-${item.id}`} aria-hidden="true">
                        {item.word}
                      </span>
                    </>
                  )}
                  <span className="ae-world-word-text">
                    {useLetterSplit
                      ? Array.from(item.word).map((ch, idx) => (
                          <span key={idx} className="ae-letter-mask">
                            <span
                              className="ae-letter"
                              style={{ '--li': idx } as React.CSSProperties}
                            >
                              {ch}
                            </span>
                          </span>
                        ))
                      : item.word}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
