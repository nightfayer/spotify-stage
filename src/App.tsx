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
import { fetchSyncedLyrics, getActiveLyricState, type ActiveLyricState } from './lib/lyrics';
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
  FontStyleMode,
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

type StyledLyricState = ActiveLyricState & {
  slot: (typeof LYRIC_SLOTS)[number];
  fx: (typeof LYRIC_FX)[number];
};

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
  const [fontStyle, setFontStyle] = useState<FontStyleMode>('pixel');
  const [bouncingBall, setBouncingBall] = useState(true);
  const [palettePreset, setPalettePreset] = useState<PalettePresetId>('cover');
  const [audioGain, setAudioGain] = useState(1.0);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[]>(DEMO_LYRICS[DEMO_TRACKS[0].id] ?? []);
  const lyricsOverlayRef = useRef<HTMLDivElement | null>(null);
  const lyricWordsRef = useRef<HTMLParagraphElement | null>(null);
  const progressFillRef = useRef<HTMLDivElement | null>(null);
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  const playbackClockRef = useRef<PlaybackClock>({
    progressMs: DEMO_TRACKS[0].progressMs,
    updatedAt: performance.now(),
    isPlaying: DEMO_TRACKS[0].isPlaying,
  });
  const [activeLyric, setActiveLyric] = useState<StyledLyricState | null>(null);

  const hudLayerRef = useRef<HTMLDivElement | null>(null);
  const lastVjSwitchRef = useRef<number>(Date.now());
  const [hudVisible, setHudVisible] = useState(true);
  const hudVisibleRef = useRef(true);
  const [hudPinned, setHudPinned] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [titleCardTrack, setTitleCardTrack] = useState<TrackState | null>(null);

  const lastTrackIdRef = useRef<string>(DEMO_TRACKS[0].id);
  const prevTitleTrackIdRef = useRef<string>(DEMO_TRACKS[0].id);
  const hideTimerRef = useRef<number | null>(null);
  const lastHudWakeRef = useRef<number>(0);
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

  const wakeHud = useCallback(() => {
    const now = performance.now();
    if (hudVisibleRef.current && now - lastHudWakeRef.current < 180) return;
    lastHudWakeRef.current = now;

    if (!hudVisibleRef.current) {
      hudVisibleRef.current = true;
      setHudVisible(true);
    }
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    if (!hudPinned && !modalOpen && !tuneOpen) {
      hideTimerRef.current = window.setTimeout(() => {
        hudVisibleRef.current = false;
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

  const cycleFontStyle = useCallback(() => {
    setFontStyle((prev) => {
      const next: FontStyleMode =
        prev === 'pixel' ? 'editorial' : prev === 'editorial' ? 'brutal' : 'pixel';
      const labels: Record<FontStyleMode, string> = {
        pixel: 'Шрифт: 8-bit Pixel',
        editorial: 'Шрифт: Журнальный (Editorial)',
        brutal: 'Шрифт: Вариативный Brutal (Unbounded)',
      };
      showNotice(labels[next], 1700);
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

  // Poll Spotify playback when authenticated (RTT-compensated, non-blocking palette & lyrics)
  useEffect(() => {
    if (!isAuthenticated) {
      syncPlaybackRef.current = null;
      return;
    }

    let cancelled = false;
    let lyricsAbort: AbortController | null = null;
    let inFlight = false;

    const syncPlayback = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const snapshot = await fetchSpotifyPlayback();
        if (cancelled) return;
        if (!snapshot) {
          setStatusNotice('Включите любой трек в Spotify');
          return;
        }
        setStatusNotice(null);

        // Update high-precision playback clock immediately with RTT-compensated timestamp
        playbackClockRef.current = {
          progressMs: snapshot.progressMs,
          updatedAt: snapshot.sampledAt,
          isPlaying: snapshot.isPlaying,
        };

        const trackChanged = snapshot.id !== lastTrackIdRef.current;
        if (trackChanged) {
          lastTrackIdRef.current = snapshot.id;
          lyricsAbort?.abort();
          lyricsAbort = new AbortController();
          const signal = lyricsAbort.signal;

          // Update track immediately without waiting for album art palette extraction
          setTrack((prev) => ({
            id: snapshot.id,
            title: snapshot.title,
            artist: snapshot.artist,
            album: snapshot.album,
            coverUrl: snapshot.coverUrl,
            genres: snapshot.genres,
            durationMs: snapshot.durationMs,
            progressMs: snapshot.progressMs,
            isPlaying: snapshot.isPlaying,
            palette: prev.palette,
          }));
          setLyrics([]);

          // Extract palette and fetch synced lyrics in parallel
          void extractPaletteFromImage(snapshot.coverUrl).then((palette) => {
            if (!cancelled && lastTrackIdRef.current === snapshot.id) {
              setTrack((prev) => (prev.id === snapshot.id ? { ...prev, palette } : prev));
            }
          });

          void fetchSyncedLyrics(snapshot.artist, snapshot.title, snapshot.durationMs, signal).then(
            (lines) => {
              if (!cancelled && lastTrackIdRef.current === snapshot.id) {
                setLyrics(lines);
              }
            }
          );
        } else {
          setTrack((prev) => {
            const genresChanged =
              snapshot.genres.length > 0 && prev.genres.length === 0;
            if (prev.isPlaying === snapshot.isPlaying && !genresChanged) {
              return prev;
            }
            return {
              ...prev,
              isPlaying: snapshot.isPlaying,
              genres: genresChanged ? snapshot.genres : prev.genres,
            };
          });
        }
      } catch (err) {
        if (!cancelled) {
          setStatusNotice(err instanceof Error ? err.message : 'Ошибка связи со Spotify');
          if (!isSpotifyAuthenticated()) setIsAuthenticated(false);
        }
      } finally {
        inFlight = false;
      }
    };

    const onVisibility = () => {
      if (!document.hidden) {
        void syncPlayback();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    syncPlaybackRef.current = syncPlayback;
    void syncPlayback();
    const interval = window.setInterval(syncPlayback, 2000);
    return () => {
      cancelled = true;
      lyricsAbort?.abort();
      syncPlaybackRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
    };
  }, [isAuthenticated]);

  // 60+ FPS frame-accurate progress bar, timecode, and lyric sync (zero periodic React re-renders)
  useEffect(() => {
    let rafId = 0;
    let lastSecond = -1;
    let lastLyricKey = '';
    const durationMs = Math.max(1, track.durationMs);
    const formattedDuration = formatTime(durationMs);

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (document.hidden) return;

      const now = performance.now();
      const clock = playbackClockRef.current;
      let liveMs = clock.isPlaying ? clock.progressMs + (now - clock.updatedAt) : clock.progressMs;

      if (liveMs >= durationMs) {
        if (isAuthenticated) {
          liveMs = durationMs;
        } else {
          liveMs = liveMs % durationMs;
          clock.progressMs = liveMs;
          clock.updatedAt = now;
        }
      }

      // 1. GPU-composited progress bar (no React re-render, no layout reflow)
      const fill = progressFillRef.current;
      if (fill) {
        fill.style.transform = `scaleX(${Math.min(1, Math.max(0, liveMs / durationMs)).toFixed(4)})`;
      }

      // 2. Timecode DOM update only once per second
      const curSec = Math.floor(liveMs / 1000);
      if (curSec !== lastSecond) {
        lastSecond = curSec;
        const tc = timecodeRef.current;
        if (tc) {
          tc.textContent = `${formatTime(liveMs)} / ${formattedDuration}`;
        }
      }

      // 3. Frame-accurate lyric line & word trigger (re-renders ONLY when line or word changes)
      if (lyricMode === 'off' || lyrics.length === 0) {
        if (lastLyricKey !== 'off') {
          lastLyricKey = 'off';
          setActiveLyric(null);
        }
        return;
      }

      const state = getActiveLyricState(lyrics, liveMs);
      const nextKey = state ? `${state.index}:${state.activeWordIndex}` : 'none';
      if (nextKey !== lastLyricKey) {
        lastLyricKey = nextKey;
        if (!state) {
          setActiveLyric(null);
        } else {
          const slot = LYRIC_SLOTS[state.index % LYRIC_SLOTS.length];
          const fx = LYRIC_FX[state.index % LYRIC_FX.length];
          setActiveLyric({ ...state, slot, fx });
        }
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isAuthenticated, lyricMode, lyrics, track.durationMs, track.id]);

  // Sync demo track when not authenticated
  useEffect(() => {
    if (isAuthenticated) return;
    const demo = DEMO_TRACKS[demoIndex];
    lastTrackIdRef.current = demo.id;
    playbackClockRef.current = {
      progressMs: demo.progressMs,
      updatedAt: performance.now(),
      isPlaying: demo.isPlaying,
    };
    setTrack(demo);
    setLyrics(DEMO_LYRICS[demo.id] ?? []);
  }, [demoIndex, isAuthenticated]);

  // Mouse activity listener for auto-hide HUD
  useEffect(() => {
    wakeHud();
    const onMove = () => wakeHud();
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('touchstart', onMove, { passive: true });
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
    const nextPlaying = !track.isPlaying;
    const now = performance.now();
    const clock = playbackClockRef.current;
    const currentMs = clock.isPlaying ? clock.progressMs + (now - clock.updatedAt) : clock.progressMs;

    // Optimistic instant UI & clock update (0ms perceived latency)
    playbackClockRef.current = {
      progressMs: Math.min(track.durationMs, currentMs),
      updatedAt: now,
      isPlaying: nextPlaying,
    };
    setTrack((prev) => ({ ...prev, isPlaying: nextPlaying }));

    if (isAuthenticated) {
      try {
        await controlSpotifyPlayback(nextPlaying ? 'play' : 'pause');
      } catch {
        // Roll back on failure
        playbackClockRef.current = {
          progressMs: Math.min(track.durationMs, currentMs),
          updatedAt: performance.now(),
          isPlaying: !nextPlaying,
        };
        setTrack((prev) => ({ ...prev, isPlaying: !nextPlaying }));
        showNotice('Откройте активный плеер Spotify');
      }
    }
  }, [isAuthenticated, showNotice, track.durationMs, track.isPlaying]);

  const handleNext = useCallback(async () => {
    if (isAuthenticated) {
      try {
        await controlSpotifyPlayback('next');
        window.setTimeout(() => void syncPlaybackRef.current?.(), 220);
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
        window.setTimeout(() => void syncPlaybackRef.current?.(), 220);
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

  // Keyboard shortcuts (layout-independent via e.code so hotkeys respond instantly on RU/EN layouts)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (modalOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (e.code === 'Digit0' || e.key === '0') {
        lastVjSwitchRef.current = Date.now();
        setBiomeChoice('auto');
      } else if (e.code === 'Digit1' || e.key === '1') {
        setBiomeChoice('pixel-horizon');
      } else if (e.code === 'Digit2' || e.key === '2') {
        setBiomeChoice('pixel-plasma');
      } else if (e.code === 'Digit3' || e.key === '3') {
        setBiomeChoice('pixel-tunnel');
      } else if (e.code === 'Digit4' || e.key === '4') {
        setBiomeChoice('pixel-kaleido');
      } else if (e.code === 'Digit5' || e.key === '5') {
        setBiomeChoice('pixel-echo');
      } else if (e.code === 'Digit6' || e.key === '6') {
        setBiomeChoice('kinetic-type');
      } else if (e.code === 'KeyM') {
        void toggleMic();
      } else if (e.code === 'KeyA') {
        void toggleSystemAudio();
      } else if (e.code === 'KeyL') {
        cycleLyricMode();
      } else if (e.code === 'KeyF') {
        cycleFontStyle();
      } else if (e.code === 'KeyG') {
        setTuneOpen((v) => !v);
      } else if (e.code === 'KeyS') {
        handleSnapshot();
      } else if (e.code === 'KeyH') {
        setHudPinned((prev) => {
          const next = !prev;
          hudVisibleRef.current = true;
          setHudVisible(true);
          return next;
        });
      } else if (e.code === 'Space') {
        e.preventDefault();
        void handlePlayPause();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    cycleFontStyle,
    cycleLyricMode,
    handlePlayPause,
    handleSnapshot,
    modalOpen,
    toggleMic,
    toggleSystemAudio,
  ]);

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

  const hideCursor = !hudVisible && !hudPinned && !modalOpen && !tuneOpen;

  return (
    <main className={`stage-root ${hideCursor ? 'is-idle-cursor' : ''}`}>
      <StageCanvas
        ref={stageRef}
        biome={resolvedBiome}
        track={effectiveTrack}
        clockRef={playbackClockRef}
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
          fontStyle={fontStyle}
        />
      )}

      {/* Lyrics Overlay: Kinetic Mode OR 3-Line Scroll Mode */}
      {resolvedBiome !== 'kinetic-type' &&
        activeLyric &&
        !titleCardTrack &&
        lyricMode === 'kinetic' && (
        <div
          ref={lyricsOverlayRef}
          className={`lyrics-overlay ${activeLyric.slot} ${activeLyric.fx} ${fontStyle === 'pixel' ? 'is-pixel-font' : fontStyle === 'brutal' ? 'is-brutal-font' : ''}`}
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
              pixelStyle={fontStyle === 'pixel'}
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
          className={`lyrics-scroll-stack ${fontStyle === 'pixel' ? 'is-pixel-font' : fontStyle === 'brutal' ? 'is-brutal-font' : ''}`}
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
              pixelStyle={fontStyle === 'pixel'}
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
              <span ref={timecodeRef} className="timecode-tag">
                {formatTime(track.progressMs)} / {formatTime(track.durationMs)}
              </span>
            </div>
            <h1 className="track-title">{track.title}</h1>
            <p className="track-artist">{track.artist}</p>
            <div className="progress-track">
              <div
                ref={progressFillRef}
                className="progress-fill"
                style={{
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
                className={`icon-btn ${fontStyle !== 'editorial' ? 'is-active-pill' : ''}`}
                onClick={cycleFontStyle}
                title={`Шрифт: ${fontStyle} (F)`}
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
