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
  showBall: boolean;
  fontStyle: FontStyleMode;
  lyricOffsetMs: number;
}

function getViewportScale(): number {
  if (typeof window === 'undefined') return 1;
  return Number(Math.min(1.3, Math.max(0.55, window.innerWidth / 1280)).toFixed(3));
}

export const KineticTypeStage = memo(function KineticTypeStage({
  track,
  activeLyric,
  isInterlude,
  beatRef,
  clockRef,
  showBall,
  fontStyle,
  lyricOffsetMs,
}: KineticTypeStageProps) {
  void showBall;
  void lyricOffsetMs;
  const topProgressFillRef = useRef<HTMLDivElement | null>(null);
  const [fontsLoadedTick, setFontsLoadedTick] = useState(0);
  const [viewportScale, setViewportScale] = useState(getViewportScale);

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
    const duration = Math.max(1, track.durationMs);
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const fill = topProgressFillRef.current;
      if (!fill) return;
      const clock = clockRef.current;
      const liveMs = clock.isPlaying
        ? clock.progressMs + (performance.now() - clock.updatedAt)
        : clock.progressMs;
      const ratio = Math.min(1, Math.max(0, liveMs / duration));
      fill.style.transform = `scaleX(${ratio.toFixed(4)})`;
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

      {/* Signature Intro / Interlude Pulsing Circle (like 00:00 of the reference video) OR Continuous 2D Camera */}
      {isInterlude ? (
        <div className="ae-intro-circle-wrap" aria-hidden="true">
          <span className="ae-intro-circle" />
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
                  className={`ae-world-word variant-${item.variant} ${stateCls} ${hasPunctuation ? 'has-accent-mark' : ''}`}
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
                  <span className="ae-world-word-text">{item.word}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
