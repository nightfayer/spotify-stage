import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveLyricState } from '../lib/lyrics';
import type { FontStyleMode, TrackState } from '../types';
import { BouncingBall, type PlaybackClock } from './BouncingBall';

interface KineticTypeStageProps {
  track: TrackState;
  activeLyric: ActiveLyricState | null;
  beatRef: React.RefObject<HTMLDivElement | null>;
  clockRef: React.RefObject<PlaybackClock>;
  showBall: boolean;
  fontStyle: FontStyleMode;
  lyricOffsetMs: number;
}

const SHOT_STYLES = [
  'shot-hero-italic',
  'shot-outline-fill',
  'shot-mirror-echo',
  'shot-staircase',
  'shot-marker-pop',
  'shot-3d-tilt',
  'shot-split-wide',
  'shot-editorial-right',
] as const;

const CAM_MODES = ['cam-flip-3d', 'cam-fly', 'cam-roll-3d', 'cam-whip', 'cam-drop'] as const;

type ShotClass = (typeof SHOT_STYLES)[number] | 'shot-impact-hook';

interface ShotSnapshot {
  key: string;
  index: number;
  words: string[];
  heroWordIdx: number;
  heroWord: string;
  shotClass: ShotClass;
  camClass: (typeof CAM_MODES)[number];
}

function pickHeroWordIndex(words: string[]): number {
  if (words.length <= 1) return 0;
  let bestIdx = 0;
  let bestLen = 0;
  for (let i = 0; i < words.length; i++) {
    const cleanLen = words[i].replace(/[^a-zA-Zа-яА-Я0-9]/g, '').length;
    if (cleanLen >= bestLen) {
      bestLen = cleanLen;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export const KineticTypeStage = memo(function KineticTypeStage({
  track,
  activeLyric,
  beatRef,
  clockRef,
  showBall,
  fontStyle,
  lyricOffsetMs,
}: KineticTypeStageProps) {
  const wordsContainerRef = useRef<HTMLDivElement | null>(null);
  const topProgressFillRef = useRef<HTMLDivElement | null>(null);

  // Smooth 60+ FPS GPU-composited top progress bar driven directly from clockRef (zero React re-renders)
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

  const currentShot = useMemo<ShotSnapshot>(() => {
    const words =
      activeLyric && activeLyric.words.length > 0
        ? activeLyric.words
        : track.title.split(/\s+/).filter(Boolean);
    const idx = activeLyric ? activeLyric.index : 0;
    const heroWordIdx = pickHeroWordIndex(words);
    let shotClass: ShotClass = SHOT_STYLES[idx % SHOT_STYLES.length];
    if (words.length <= 2 || (activeLyric?.text.endsWith('!') && words.length <= 4)) {
      shotClass = 'shot-impact-hook';
    } else if (shotClass === 'shot-staircase' && words.length > 6) {
      shotClass = 'shot-hero-italic';
    }
    return {
      key: `${track.id}-${idx}-${words.join('_')}`,
      index: idx,
      words,
      heroWordIdx,
      heroWord: words[heroWordIdx] ?? '',
      shotClass,
      camClass: CAM_MODES[idx % CAM_MODES.length],
    };
  }, [activeLyric, track.id, track.title]);

  const [exitingShot, setExitingShot] = useState<ShotSnapshot | null>(null);
  const prevShotRef = useRef<ShotSnapshot>(currentShot);

  useEffect(() => {
    if (prevShotRef.current.key !== currentShot.key) {
      const leaving = prevShotRef.current;
      prevShotRef.current = currentShot;
      setExitingShot(leaving);
      const timer = window.setTimeout(() => setExitingShot(null), 520);
      return () => window.clearTimeout(timer);
    }
  }, [currentShot]);

  const activeWordIdx = activeLyric ? activeLyric.activeWordIndex : currentShot.words.length - 1;

  return (
    <div
      ref={beatRef}
      className={`reels-type-stage font-${fontStyle}`}
      style={
        {
          '--reel-primary': track.palette.primary,
          '--reel-secondary': track.palette.secondary,
          '--reel-accent': track.palette.accent,
          '--reel-bg': track.palette.background,
        } as React.CSSProperties
      }
    >
      {/* Viral Reels / Apple Music ambient blurred album cover backdrop */}
      {track.coverUrl && (
        <div
          className="reels-cover-backdrop"
          style={{ backgroundImage: `url("${track.coverUrl}")` }}
          aria-hidden="true"
        />
      )}

      {/* Razor-thin editorial top progress hairline */}
      <div className="reels-top-progress" aria-hidden="true">
        <div ref={topProgressFillRef} className="reels-top-progress-fill" />
      </div>

      {/* Giant outlined ghost watermark tinted by cover primary color */}
      {currentShot.heroWord && (
        <div className="reels-ghost-word" key={`ghost-${currentShot.key}`} aria-hidden="true">
          {currentShot.heroWord}
        </div>
      )}

      {/* Subtle Instagram Music / Reels top header pill */}
      <div className="reels-frame-meta" aria-hidden="true">
        <span className="reels-shot-badge">
          <i className="reels-live-dot" />
          SHOT {String(currentShot.index + 1).padStart(2, '0')}
        </span>

        <div className="reels-music-pill">
          {track.coverUrl && <img src={track.coverUrl} alt="" className="reels-pill-cover" />}
          <span>
            {track.title} · {track.artist}
          </span>
        </div>

        <span>{track.album.toUpperCase()}</span>
      </div>

      {/* Camera Transition exiting shot */}
      {exitingShot && (
        <div
          className={`reels-shot is-exiting ${exitingShot.shotClass} ${exitingShot.camClass}`}
          key={`exit-${exitingShot.key}`}
          aria-hidden="true"
        >
          <div className="reels-words">
            {exitingShot.words.map((w, i) => (
              <span
                key={`${i}-${w}`}
                className={`reels-word-mask ${i === exitingShot.heroWordIdx ? 'is-hero' : ''}`}
              >
                <span className="reels-word-inner">{w}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Active Editorial Montage Shot */}
      <div
        className={`reels-shot is-entering ${currentShot.shotClass} ${currentShot.camClass}`}
        key={`curr-${currentShot.key}`}
      >
        <div className="reels-words" ref={wordsContainerRef}>
          {activeLyric && (
            <BouncingBall
              containerRef={wordsContainerRef}
              clockRef={clockRef}
              lineStartMs={activeLyric.lineStartMs}
              lineDurationMs={activeLyric.lineDurationMs}
              wordCount={currentShot.words.length}
              lineKey={currentShot.key}
              wordSelector=".reels-word-mask"
              topOffset={6}
              visible={showBall}
              lyricOffsetMs={lyricOffsetMs}
            />
          )}
          {currentShot.words.map((word, wIdx) => {
            const isHero = wIdx === currentShot.heroWordIdx;
            const stateClass =
              wIdx === activeWordIdx
                ? 'is-active'
                : wIdx < activeWordIdx
                  ? 'is-spoken'
                  : 'is-upcoming';
            return (
              <span
                key={`${wIdx}-${word}`}
                className={`reels-word-mask ${isHero ? 'is-hero' : ''} ${stateClass}`}
                style={{ '--word-i': wIdx } as React.CSSProperties}
              >
                <span className="reels-word-inner" data-word={word}>
                  {word}
                </span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
});
