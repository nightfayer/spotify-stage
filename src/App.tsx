import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Camera,
  Captions,
  Eye,
  EyeOff,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Pause,
  Play,
  Radio,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Type,
} from 'lucide-react';
import { BouncingBall, type PlaybackClock } from './components/BouncingBall';
import { KineticTypeStage } from './components/KineticTypeStage';
import { StageCanvas, type StageCanvasHandle } from './components/StageCanvas';
import { SpotifyConnectModal } from './components/SpotifyConnectModal';
import { LiveAudioAnalyzer } from './lib/audio';
import { DEMO_LYRICS, DEMO_TRACKS } from './lib/demoTracks';
import { fetchSyncedLyrics, getActiveLyricState } from './lib/lyrics';
import {
  extractPaletteFromImage,
  PALETTE_PRESETS,
  resolveBiomeForGenres,
} from './lib/palette';
import {
  controlSpotifyPlayback,
  fetchSpotifyPlayback,
  handleSpotifyCallbackIfPresent,
  isSpotifyAuthenticated,
} from './lib/spotify';
import type {
  AudioSourceType,
  BiomeId,
  LyricLine,
  LyricMode,
  PalettePresetId,
  ResolvedBiome,
  TrackState,
} from './types';

const BIOME_LABELS: { id: BiomeId; label: string }[] = [
  { id: 'auto', label: 'Auto VJ' },
  { id: 'pixel-horizon', label: 'Ocean' },
  { id: 'pixel-plasma', label: 'Plasma' },
  { id: 'pixel-tunnel', label: 'Tunnel' },
  { id: 'pixel-kaleido', label: 'Kaleido' },
  { id: 'pixel-echo', label: 'Echo' },
  { id: 'kinetic-type', label: 'Type' },
];

const VJ_ROTATION: ResolvedBiome[] = [
  'pixel-horizon',
  'pixel-tunnel',
  'pixel-kaleido',
  'pixel-echo',
  'pixel-plasma',
];

const PALETTE_OPTIONS: { id: PalettePresetId; label: string }[] = [
  { id: 'cover', label: 'Cover' },
  { id: 'gameboy', label: 'Game Boy' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'cyber', label: 'Cyber' },
  { id: 'crimson', label: 'Crimson' },
];

const LYRIC_SLOTS = [
  'slot-center-hero',
  'slot-top-left',
  'slot-mid-right',
  'slot-bottom-left',
  'slot-top-right',
  'slot-mid-left',
] as const;

const LYRIC_FX = ['fx-glitch', 'fx-slam', 'fx-wipe', 'fx-stamp'] as const;

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function App() {
  const stageRef = useRef<StageCanvasHandle | null>(null);
  const analyzerRef = useRef<LiveAudioAnalyzer | null>(null);
  if (!analyzerRef.current) {
    analyzerRef.current = new LiveAudioAnalyzer();
  }

  const [isAuthenticated, setIsAuthenticated] = useState(() => isSpotifyAuthenticated());
  const [demoIndex, setDemoIndex] = useState(0);
  const [track, setTrack] = useState<TrackState>(DEMO_TRACKS[0]);
  const [biomeChoice, setBiomeChoice] = useState<BiomeId>('auto');
  const [vjStep, setVjStep] = useState(0);
  const [audioSource, setAudioSource] = useState<AudioSourceType>('none');
  const [lyricMode, setLyricMode] = useState<LyricMode>('kinetic');
  const [pixelFont, setPixelFont] = useState(true);
  const [bouncingBall, setBouncingBall] = useState(true);
  const [palettePreset, setPalettePreset] = useState<PalettePresetId>('cover');
  const [audioGain, setAudioGain] = useState(1.0);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[]>(DEMO_LYRICS[DEMO_TRACKS[0].id] ?? []);
  const lyricsOverlayRef = useRef<HTMLDivElement | null>(null);
  const lyricWordsRef = useRef<HTMLParagraphElement | null>(null);
  const playbackClockRef = useRef<PlaybackClock>({
    progressMs: DEMO_TRACKS[0].progressMs,
    updatedAt: performance.now(),
    isPlaying: DEMO_TRACKS[0].isPlaying,
  });

  // Sync playback clock ONLY when progressMs or isPlaying actually changes (prevents backward jumps on unrelated re-renders)
  useEffect(() => {
    playbackClockRef.current = {
      progressMs: track.progressMs,
      updatedAt: performance.now(),
      isPlaying: track.isPlaying,
    };
  }, [track.progressMs, track.isPlaying]);
  const hudLayerRef = useRef<HTMLDivElement | null>(null);
  const lastVjSwitchRef = useRef<number>(Date.now());
  const [hudVisible, setHudVisible] = useState(true);
  const [hudPinned, setHudPinned] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [titleCardTrack, setTitleCardTrack] = useState<TrackState | null>(null);

  const lastTrackIdRef = useRef<string>(DEMO_TRACKS[0].id);
  const prevTitleTrackIdRef = useRef<string>(DEMO_TRACKS[0].id);
  const hideTimerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const titleCardTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((msg: string, durationMs = 2200) => {
    setStatusNotice(msg);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setStatusNotice(null), durationMs);
  }, []);

  // Show Arcade Stage Title Card + center shockwave on track change
  useEffect(() => {
    if (track.id === prevTitleTrackIdRef.current) return;
    prevTitleTrackIdRef.current = track.id;
    setTitleCardTrack(track);
    stageRef.current?.triggerShockwave(0.5, 0.5);
    if (titleCardTimerRef.current) window.clearTimeout(titleCardTimerRef.current);
    titleCardTimerRef.current = window.setTimeout(() => {
      setTitleCardTrack(null);
    }, 2600);
  }, [track]);

  useEffect(() => {
    const analyzer = analyzerRef.current;
    return () => {
      analyzer?.stop();
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
      if (titleCardTimerRef.current) window.clearTimeout(titleCardTimerRef.current);
    };
  }, []);

  const resolvedBiome = useMemo(() => {
    if (biomeChoice !== 'auto') return biomeChoice;
    const base = resolveBiomeForGenres(track.genres);
    const baseIdx = VJ_ROTATION.indexOf(base);
    return VJ_ROTATION[(Math.max(0, baseIdx) + vjStep) % VJ_ROTATION.length];
  }, [biomeChoice, track.genres, vjStep]);

  // VJ Auto-Director: fallback timer every 26s (also switches on strong beat drops in handleMetricsFrame)
  useEffect(() => {
    if (biomeChoice !== 'auto' || !track.isPlaying) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (now - lastVjSwitchRef.current >= 22_000) {
        lastVjSwitchRef.current = now;
        setVjStep((s) => s + 1);
      }
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [biomeChoice, track.isPlaying]);

  const effectiveTrack = useMemo<TrackState>(() => {
    if (palettePreset === 'cover') return track;
    return { ...track, palette: PALETTE_PRESETS[palettePreset] };
  }, [palettePreset, track]);

  const activeLyric = useMemo(() => {
    if (lyricMode === 'off') return null;
    const state = getActiveLyricState(lyrics, track.progressMs);
    if (!state) return null;
    const slot = LYRIC_SLOTS[state.index % LYRIC_SLOTS.length];
    const fx = LYRIC_FX[state.index % LYRIC_FX.length];
    return { ...state, slot, fx };
  }, [lyrics, lyricMode, track.progressMs]);

  const wakeHud = useCallback(() => {
    setHudVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (!hudPinned && !modalOpen && !tuneOpen) {
      hideTimerRef.current = window.setTimeout(() => {
        setHudVisible(false);
      }, 3600);
    }
  }, [hudPinned, modalOpen, tuneOpen]);

  useEffect(() => {
    analyzerRef.current?.setGain(audioGain);
  }, [audioGain]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const cycleLyricMode = useCallback(() => {
    setLyricMode((prev) => {
      const next: LyricMode = prev === 'kinetic' ? 'scroll' : prev === 'scroll' ? 'off' : 'kinetic';
      const labels: Record<LyricMode, string> = {
        kinetic: 'Субтитры: Кинетические',
        scroll: 'Субтитры: Скролл (3 строки)',
        off: 'Субтитры: Выкл',
      };
      showNotice(labels[next], 1600);
      return next;
    });
  }, [showNotice]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      showNotice('Полноэкранный режим недоступен');
    }
  }, [showNotice]);

  // Handle OAuth PKCE redirect on mount
  useEffect(() => {
    handleSpotifyCallbackIfPresent()
      .then((loggedIn) => {
        if (loggedIn) {
          setIsAuthenticated(true);
          setStatusNotice('Spotify подключён');
          setTimeout(() => setStatusNotice(null), 2500);
        }
      })
      .catch((err) => {
        setStatusNotice(err instanceof Error ? err.message : 'Ошибка входа Spotify');
      });
  }, []);

  const syncPlaybackRef = useRef<(() => Promise<void>) | null>(null);

  // Poll Spotify playback when authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      syncPlaybackRef.current = null;
      return;
    }

    let cancelled = false;
    const syncPlayback = async () => {
      try {
        const snapshot = await fetchSpotifyPlayback();
        if (cancelled) return;
        if (!snapshot) {
          setStatusNotice('Включите любой трек в Spotify');
          return;
        }
        setStatusNotice(null);

        const trackChanged = snapshot.id !== lastTrackIdRef.current;
        if (trackChanged) {
          lastTrackIdRef.current = snapshot.id;
          const palette = await extractPaletteFromImage(snapshot.coverUrl);
          if (cancelled) return;
          setTrack({ ...snapshot, palette });

          fetchSyncedLyrics(snapshot.artist, snapshot.title, snapshot.durationMs).then((lines) => {
            if (!cancelled && lastTrackIdRef.current === snapshot.id) {
              setLyrics(lines);
            }
          });
        } else {
          setTrack((prev) => ({
            ...prev,
            progressMs: snapshot.progressMs,
            isPlaying: snapshot.isPlaying,
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setStatusNotice(err instanceof Error ? err.message : 'Ошибка связи со Spotify');
          if (!isSpotifyAuthenticated()) setIsAuthenticated(false);
        }
      }
    };

    syncPlaybackRef.current = syncPlayback;
    void syncPlayback();
    const interval = window.setInterval(syncPlayback, 3500);
    return () => {
      cancelled = true;
      syncPlaybackRef.current = null;
      window.clearInterval(interval);
    };
  }, [isAuthenticated]);

  // Drift-free 80ms progress tick for tight lyric & bouncing-ball sync
  useEffect(() => {
    let lastTick = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min(400, Math.max(0, now - lastTick));
      lastTick = now;
      setTrack((prev) => {
        if (!prev.isPlaying) return prev;
        const next = prev.progressMs + elapsed;
        if (next >= prev.durationMs) {
          return { ...prev, progressMs: isAuthenticated ? prev.durationMs : 0 };
        }
        return { ...prev, progressMs: next };
      });
    }, 80);
    return () => window.clearInterval(timer);
  }, [isAuthenticated]);

  // Sync demo track when not authenticated
  useEffect(() => {
    if (isAuthenticated) return;
    const demo = DEMO_TRACKS[demoIndex];
    lastTrackIdRef.current = demo.id;
    setTrack(demo);
    setLyrics(DEMO_LYRICS[demo.id] ?? []);
  }, [demoIndex, isAuthenticated]);

  // Mouse activity listener for auto-hide HUD
  useEffect(() => {
    wakeHud();
    const onMove = () => wakeHud();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchstart', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchstart', onMove);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [wakeHud]);

  const toggleMic = useCallback(async () => {
    const analyzer = analyzerRef.current;
    if (!analyzer) return;
    if (audioSource === 'mic') {
      analyzer.stop();
      setAudioSource('none');
      return;
    }
    try {
      await analyzer.startMic(() => setAudioSource('none'));
      setAudioSource('mic');
      showNotice('Микрофон включён', 2000);
    } catch {
      showNotice('Нет доступа к микрофону', 2500);
    }
  }, [audioSource, showNotice]);

  const toggleSystemAudio = useCallback(async () => {
    const analyzer = analyzerRef.current;
    if (!analyzer) return;
    if (audioSource === 'system') {
      analyzer.stop();
      setAudioSource('none');
      return;
    }
    try {
      await analyzer.startSystemAudio(() => setAudioSource('none'));
      setAudioSource('system');
      showNotice('Захват звука вкладки включён', 2200);
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Не удалось захватить звук', 3000);
    }
  }, [audioSource, showNotice]);

  const handlePlayPause = useCallback(async () => {
    if (isAuthenticated) {
      try {
        await controlSpotifyPlayback(track.isPlaying ? 'pause' : 'play');
        setTrack((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
      } catch {
        showNotice('Откройте активный плеер Spotify');
      }
    } else {
      setTrack((prev) => ({ ...prev, isPlaying: !prev.isPlaying }));
    }
  }, [isAuthenticated, showNotice, track.isPlaying]);

  const handleNext = useCallback(async () => {
    if (isAuthenticated) {
      try {
        await controlSpotifyPlayback('next');
        window.setTimeout(() => void syncPlaybackRef.current?.(), 450);
      } catch {
        showNotice('Не удалось переключить трек');
      }
    } else {
      setDemoIndex((i) => (i + 1) % DEMO_TRACKS.length);
    }
  }, [isAuthenticated, showNotice]);

  const handlePrev = useCallback(async () => {
    if (isAuthenticated) {
      try {
        await controlSpotifyPlayback('previous');
        window.setTimeout(() => void syncPlaybackRef.current?.(), 450);
      } catch {
        showNotice('Не удалось переключить трек');
      }
    } else {
      setDemoIndex((i) => (i - 1 + DEMO_TRACKS.length) % DEMO_TRACKS.length);
    }
  }, [isAuthenticated, showNotice]);

  const handleSnapshot = useCallback(() => {
    stageRef.current?.capturePoster(effectiveTrack);
    showNotice('Постер сохранён', 1800);
  }, [effectiveTrack, showNotice]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (modalOpen) return;
      if (e.key === '0') {
        lastVjSwitchRef.current = Date.now();
        setBiomeChoice('auto');
      }
      if (e.key === '1') setBiomeChoice('pixel-horizon');
      if (e.key === '2') setBiomeChoice('pixel-plasma');
      if (e.key === '3') setBiomeChoice('pixel-tunnel');
      if (e.key === '4') setBiomeChoice('pixel-kaleido');
      if (e.key === '5') setBiomeChoice('pixel-echo');
      if (e.key === '6') setBiomeChoice('kinetic-type');
      if (e.key.toLowerCase() === 'm') void toggleMic();
      if (e.key.toLowerCase() === 'a') void toggleSystemAudio();
      if (e.key.toLowerCase() === 'l') cycleLyricMode();
      if (e.key.toLowerCase() === 'f') setPixelFont((v) => !v);
      if (e.key.toLowerCase() === 'g') setTuneOpen((v) => !v);
      if (e.key.toLowerCase() === 's') handleSnapshot();
      if (e.key.toLowerCase() === 'h') {
        setHudPinned((prev) => {
          const next = !prev;
          setHudVisible(true);
          return next;
        });
      }
      if (e.code === 'Space') {
        e.preventDefault();
        void handlePlayPause();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cycleLyricMode, handlePlayPause, handleSnapshot, modalOpen, toggleMic, toggleSystemAudio]);

  const getMetrics = useCallback((t: number, playing: boolean) => {
    return analyzerRef.current!.sample(t, playing);
  }, []);

  const handleMetricsFrame = useCallback(
    (metrics: { beat: number; bass: number; mid: number; treble: number; audioSource: AudioSourceType }) => {
      const intensity = Math.min(1, metrics.beat * 0.75 + metrics.bass * 0.45);
      const el = lyricsOverlayRef.current;
      if (el) {
        el.style.setProperty('--beat', intensity.toFixed(3));
      }
      const hud = hudLayerRef.current;
      if (hud) {
        hud.style.setProperty('--beat', intensity.toFixed(3));
        hud.style.setProperty('--bass', metrics.bass.toFixed(3));
        hud.style.setProperty('--mid', metrics.mid.toFixed(3));
        hud.style.setProperty('--treble', metrics.treble.toFixed(3));
      }

      // Beat-drop scene switch in Auto VJ mode when live audio is active (min 14s cooldown)
      if (
        biomeChoice === 'auto' &&
        metrics.audioSource !== 'none' &&
        metrics.beat > 0.74 &&
        metrics.bass > 0.5
      ) {
        const now = Date.now();
        if (now - lastVjSwitchRef.current >= 14_000) {
          lastVjSwitchRef.current = now;
          setVjStep((s) => s + 1);
        }
      }
    },
    [biomeChoice]
  );

  const progressPct = Math.min(100, (track.progressMs / Math.max(1, track.durationMs)) * 100);
  const hideCursor = !hudVisible && !hudPinned && !modalOpen && !tuneOpen;

  return (
    <main className={`stage-root ${hideCursor ? 'is-idle-cursor' : ''}`}>
      <StageCanvas
        ref={stageRef}
        biome={resolvedBiome}
        track={effectiveTrack}
        getAudioMetrics={getMetrics}
        onMetricsFrame={handleMetricsFrame}
      />

      {/* Arcade Stage Title Card on Track Change */}
      {titleCardTrack && (
        <div
          className="stage-title-card"
          key={`card-${titleCardTrack.id}`}
          style={
            {
              '--card-accent': effectiveTrack.palette.accent,
              '--card-primary': effectiveTrack.palette.primary,
            } as React.CSSProperties
          }
        >
          <span className="stage-card-kicker">NOW PLAYING // STAGE</span>
          <h2 className="stage-card-title">{titleCardTrack.title}</h2>
          <p className="stage-card-artist">{titleCardTrack.artist}</p>
          <div className="stage-card-bar" />
        </div>
      )}

      {/* Dedicated Editorial Reels Typography Stage (when 'Type' scene is active) */}
      {resolvedBiome === 'kinetic-type' && !titleCardTrack && (
        <KineticTypeStage
          track={effectiveTrack}
          activeLyric={activeLyric}
          beatRef={lyricsOverlayRef}
          clockRef={playbackClockRef}
          showBall={bouncingBall}
        />
      )}

      {/* Lyrics Overlay: Kinetic Mode OR 3-Line Scroll Mode */}
      {resolvedBiome !== 'kinetic-type' &&
        activeLyric &&
        !titleCardTrack &&
        lyricMode === 'kinetic' && (
        <div
          ref={lyricsOverlayRef}
          className={`lyrics-overlay ${activeLyric.slot} ${activeLyric.fx} ${pixelFont ? 'is-pixel-font' : ''}`}
          key={`${track.id}-${activeLyric.index}`}
          style={
            {
              '--lyric-accent': effectiveTrack.palette.accent,
              '--lyric-primary': effectiveTrack.palette.primary,
            } as React.CSSProperties
          }
        >
          <p ref={lyricWordsRef} className="lyric-line-rel">
            <BouncingBall
              containerRef={lyricWordsRef}
              clockRef={playbackClockRef}
              lineStartMs={activeLyric.lineStartMs}
              lineDurationMs={activeLyric.lineDurationMs}
              wordCount={activeLyric.words.length}
              lineKey={`${track.id}-${activeLyric.index}`}
              wordSelector=".lyric-word"
              pixelStyle={pixelFont}
              visible={bouncingBall}
            />
            {activeLyric.words.map((word, wIdx) => {
              const cls =
                wIdx === activeLyric.activeWordIndex
                  ? 'lyric-word is-active-word'
                  : wIdx < activeLyric.activeWordIndex
                    ? 'lyric-word is-revealed'
                    : 'lyric-word is-pending';
              return (
                <span key={`${wIdx}-${word}`} className={cls}>
                  {word}{' '}
                </span>
              );
            })}
          </p>
        </div>
      )}

      {resolvedBiome !== 'kinetic-type' &&
        activeLyric &&
        !titleCardTrack &&
        lyricMode === 'scroll' && (
        <div
          ref={lyricsOverlayRef}
          className={`lyrics-scroll-stack ${pixelFont ? 'is-pixel-font' : ''}`}
          style={
            {
              '--lyric-accent': effectiveTrack.palette.accent,
              '--lyric-primary': effectiveTrack.palette.primary,
            } as React.CSSProperties
          }
        >
          <p className="scroll-line is-prev">{activeLyric.prevText ?? '\u00A0'}</p>
          <p
            ref={lyricWordsRef}
            className="scroll-line is-current lyric-line-rel"
            key={`scroll-${track.id}-${activeLyric.index}`}
          >
            <BouncingBall
              containerRef={lyricWordsRef}
              clockRef={playbackClockRef}
              lineStartMs={activeLyric.lineStartMs}
              lineDurationMs={activeLyric.lineDurationMs}
              wordCount={activeLyric.words.length}
              lineKey={`scroll-${track.id}-${activeLyric.index}`}
              wordSelector=".lyric-word"
              pixelStyle={pixelFont}
              visible={bouncingBall}
            />
            {activeLyric.words.map((word, wIdx) => {
              const cls =
                wIdx === activeLyric.activeWordIndex
                  ? 'lyric-word is-active-word'
                  : wIdx < activeLyric.activeWordIndex
                    ? 'lyric-word is-revealed'
                    : 'lyric-word is-pending';
              return (
                <span key={`${wIdx}-${word}`} className={cls}>
                  {word}{' '}
                </span>
              );
            })}
          </p>
          <p className="scroll-line is-next">{activeLyric.nextText ?? '\u00A0'}</p>
        </div>
      )}

      {/* Status Toast */}
      {statusNotice && <div className="status-toast">{statusNotice}</div>}

      {/* Auto-hiding Second-Screen HUD */}
      <div
        ref={hudLayerRef}
        className={`hud-layer ${hudVisible || hudPinned ? 'is-visible' : 'is-hidden'}`}
      >
        {/* Bottom-left: Now Playing */}
        <section className="now-playing-card">
          {track.coverUrl && (
            <img src={track.coverUrl} alt={track.album} className="cover-thumb" />
          )}
          <div className="track-meta">
            <div className="track-badge-row">
              <span className="mini-eq" aria-hidden="true">
                <i className="eq-b1" style={{ backgroundColor: effectiveTrack.palette.primary }} />
                <i className="eq-b2" style={{ backgroundColor: effectiveTrack.palette.accent }} />
                <i className="eq-b3" style={{ backgroundColor: effectiveTrack.palette.secondary }} />
                <i className="eq-b4" style={{ backgroundColor: effectiveTrack.palette.primary }} />
              </span>
              <span className="mode-pill">
                {isAuthenticated ? 'Spotify Live' : 'Demo Stage'}
              </span>
              <span className="biome-tag">{resolvedBiome}</span>
              <span className="timecode-tag">
                {formatTime(track.progressMs)} / {formatTime(track.durationMs)}
              </span>
            </div>
            <h1 className="track-title">{track.title}</h1>
            <p className="track-artist">{track.artist}</p>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{
                  width: `${progressPct}%`,
                  backgroundColor: effectiveTrack.palette.primary,
                }}
              />
            </div>
          </div>

          <div className="transport-controls">
            <button type="button" className="icon-btn" onClick={handlePrev} title="Предыдущий">
              <SkipBack size={16} />
            </button>
            <button
              type="button"
              className="icon-btn primary-play"
              onClick={handlePlayPause}
              title="Пауза / Плей (Space)"
            >
              {track.isPlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button type="button" className="icon-btn" onClick={handleNext} title="Следующий">
              <SkipForward size={16} />
            </button>
          </div>
        </section>

        {/* Bottom-right: Biome & Stage Controls */}
        <section className="dock-column">
          {tuneOpen && (
            <div className="tune-popover">
              <div className="tune-group">
                <span className="tune-label">Палитра</span>
                <div className="tune-chips">
                  {PALETTE_OPTIONS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`dock-tab ${palettePreset === p.id ? 'is-active' : ''}`}
                      onClick={() => setPalettePreset(p.id)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="tune-group">
                <span className="tune-label">Чувствительность звука ({audioGain.toFixed(1)}x)</span>
                <input
                  type="range"
                  min={0.5}
                  max={2.5}
                  step={0.1}
                  value={audioGain}
                  onChange={(e) => setAudioGain(Number(e.target.value))}
                  className="gain-slider"
                />
              </div>
              <div className="tune-row-toggle">
                <span className="tune-label">Прыгающий шарик</span>
                <button
                  type="button"
                  className={`dock-tab ${bouncingBall ? 'is-active' : ''}`}
                  onClick={() => setBouncingBall((v) => !v)}
                >
                  {bouncingBall ? 'Вкл' : 'Выкл'}
                </button>
              </div>
            </div>
          )}

          <div className="control-dock">
            <div className="biome-switcher" role="group" aria-label="Выбор биома">
              {BIOME_LABELS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`dock-tab ${biomeChoice === b.id ? 'is-active' : ''}`}
                  onClick={() => {
                    if (b.id === 'auto') lastVjSwitchRef.current = Date.now();
                    setBiomeChoice(b.id);
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>

            <div className="dock-actions">
              <button
                type="button"
                className={`icon-btn ${audioSource === 'system' ? 'is-active-pill' : ''}`}
                onClick={toggleSystemAudio}
                title="Захват звука вкладки / системы (A)"
              >
                <AudioLines size={16} />
              </button>

              <button
                type="button"
                className={`icon-btn ${audioSource === 'mic' ? 'is-active-pill' : ''}`}
                onClick={toggleMic}
                title="Микрофон (M)"
              >
                {audioSource === 'mic' ? <Mic size={16} /> : <MicOff size={16} />}
              </button>

              <button
                type="button"
                className={`icon-btn ${lyricMode !== 'off' ? 'is-active-pill' : ''}`}
                onClick={cycleLyricMode}
                title={`Субтитры: ${lyricMode} (L)`}
              >
                <Captions size={16} />
              </button>

              <button
                type="button"
                className={`icon-btn ${pixelFont ? 'is-active-pill' : ''}`}
                onClick={() => setPixelFont((v) => !v)}
                title="8-битный шрифт лирики (F)"
              >
                <Type size={16} />
              </button>

              <button
                type="button"
                className={`icon-btn ${tuneOpen || palettePreset !== 'cover' ? 'is-active-pill' : ''}`}
                onClick={() => setTuneOpen((v) => !v)}
                title="Палитры и усиление звука (G)"
              >
                <SlidersHorizontal size={16} />
              </button>

              <button
                type="button"
                className="icon-btn"
                onClick={handleSnapshot}
                title="Сохранить арт-постер PNG (S)"
              >
                <Camera size={16} />
              </button>

              <button
                type="button"
                className={`icon-btn ${isFullscreen ? 'is-active-pill' : ''}`}
                onClick={toggleFullscreen}
                title="Полноэкранный режим"
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>

              <button
                type="button"
                className={`icon-btn ${hudPinned ? 'is-active-pill' : ''}`}
                onClick={() => setHudPinned((v) => !v)}
                title="Закрепить / скрыть HUD (H)"
              >
                {hudPinned ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>

              <button
                type="button"
                className={`connect-btn ${isAuthenticated ? 'is-connected' : ''}`}
                onClick={() => setModalOpen(true)}
              >
                <Radio size={15} />
                <span>{isAuthenticated ? 'Spotify OK' : 'Подключить Spotify'}</span>
              </button>
            </div>
          </div>
        </section>
      </div>

      <SpotifyConnectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onDisconnected={() => {
          setIsAuthenticated(false);
          setStatusNotice('Отключено от Spotify — включён Demo режим');
          setTimeout(() => setStatusNotice(null), 2500);
        }}
      />
    </main>
  );
}

export default App;
