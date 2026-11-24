import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Camera,
  Captions,
  Eye,
  EyeOff,
  HelpCircle,
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
import {
  fetchSyncedLyrics,
  getActiveLyricState,
  isInstrumentalGap,
  type ActiveLyricState,
} from './lib/lyrics';
import {
  extractPaletteFromImage,
  PALETTE_PRESETS,
  resolveBiomeForGenres,
} from './lib/palette';
import {
  controlSpotifyPlayback,
  fetchNextQueuedTrack,
  fetchSpotifyPlayback,
  handleSpotifyCallbackIfPresent,
  isSpotifyAuthenticated,
  seekSpotifyPlayback,
  type QueuedTrackPreview,
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

const PREFS_STORAGE_KEY = 'spotify_stage_prefs_v1';

interface SavedPrefs {
  biomeChoice?: BiomeId;
  palettePreset?: PalettePresetId;
  fontStyle?: FontStyleMode;
  lyricMode?: LyricMode;
  bouncingBall?: boolean;
  audioGain?: number;
  lyricOffsetMs?: number;
}

function loadSavedPrefs(): SavedPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SavedPrefs;
  } catch {
    return {};
  }
}

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

  const initialPrefs = useMemo(() => loadSavedPrefs(), []);
  const [isAuthenticated, setIsAuthenticated] = useState(() => isSpotifyAuthenticated());
  const [demoIndex, setDemoIndex] = useState(0);
  const [track, setTrack] = useState<TrackState>(DEMO_TRACKS[0]);
  const [biomeChoice, setBiomeChoice] = useState<BiomeId>(initialPrefs.biomeChoice ?? 'auto');
  const [vjStep, setVjStep] = useState(0);
  const [audioSource, setAudioSource] = useState<AudioSourceType>('none');
  const [lyricMode, setLyricMode] = useState<LyricMode>(initialPrefs.lyricMode ?? 'kinetic');
  const [fontStyle, setFontStyle] = useState<FontStyleMode>(initialPrefs.fontStyle ?? 'pixel');
  const [bouncingBall, setBouncingBall] = useState(initialPrefs.bouncingBall ?? true);
  const [palettePreset, setPalettePreset] = useState<PalettePresetId>(
    initialPrefs.palettePreset ?? 'cover'
  );
  const [audioGain, setAudioGain] = useState(initialPrefs.audioGain ?? 1.0);
  const [lyricOffsetMs, setLyricOffsetMs] = useState(initialPrefs.lyricOffsetMs ?? 0);
  const [oledDimmed, setOledDimmed] = useState(false);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [upNextTrack, setUpNextTrack] = useState<QueuedTrackPreview | null>(null);
  const [showUpNext, setShowUpNext] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lyrics, setLyrics] = useState<LyricLine[]>(DEMO_LYRICS[DEMO_TRACKS[0].id] ?? []);
  const lyricsOverlayRef = useRef<HTMLDivElement | null>(null);
  const lyricWordsRef = useRef<HTMLParagraphElement | null>(null);
  const progressFillRef = useRef<HTMLDivElement | null>(null);
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  const vuMeterRef = useRef<HTMLDivElement | null>(null);
  const bpmTagRef = useRef<HTMLSpanElement | null>(null);
  const lastBeatSwitchCountRef = useRef<number>(0);
  const playbackClockRef = useRef<PlaybackClock>({
    progressMs: DEMO_TRACKS[0].progressMs,
    updatedAt: performance.now(),
    isPlaying: DEMO_TRACKS[0].isPlaying,
  });
  const [activeLyric, setActiveLyric] = useState<StyledLyricState | null>(null);
  const [isInterlude, setIsInterlude] = useState(false);

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
    setOledDimmed(false);
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

  // Persist user stage preferences to localStorage
  useEffect(() => {
    try {
      const prefs: SavedPrefs = {
        biomeChoice,
        palettePreset,
        fontStyle,
        lyricMode,
        bouncingBall,
        audioGain,
        lyricOffsetMs,
      };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage quota / private mode errors
    }
  }, [audioGain, biomeChoice, bouncingBall, fontStyle, lyricMode, lyricOffsetMs, palettePreset]);

  // Screen Wake Lock API: keep second monitor / TV awake while playing
  useEffect(() => {
    if (!track.isPlaying || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        if (document.hidden || cancelled) return;
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        // Wake Lock may be rejected on low battery or unsupported contexts
      }
    };

    void acquire();
    const onVisibility = () => {
      if (!document.hidden) void acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) {
        void sentinel.release();
      }
    };
  }, [track.isPlaying]);

  // OLED burn-in protection: gently dim the stage after 90s on pause
  useEffect(() => {
    if (track.isPlaying) {
      setOledDimmed(false);
      return;
    }
    const timer = window.setTimeout(() => setOledDimmed(true), 90_000);
    return () => window.clearTimeout(timer);
  }, [track.isPlaying]);

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
        scroll: 'Субтитры: Скролл (5 строк)',
        off: 'Субтитры: Выкл',
      };
      const suffix = next !== 'off' && lyrics.length === 0 ? ' · нет текста для этого трека' : '';
      showNotice(`${labels[next]}${suffix}`, 2000);
      return next;
    });
  }, [lyrics.length, showNotice]);

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

          // Preload next track in Spotify queue (cover, palette, lyrics) for 0ms next-track latency
          setUpNextTrack(null);
          void fetchNextQueuedTrack().then((next) => {
            if (cancelled || !next || next.id === snapshot.id) return;
            setUpNextTrack(next);
            if (next.coverUrl) {
              const img = new Image();
              img.crossOrigin = 'anonymous';
              img.src = next.coverUrl;
              void extractPaletteFromImage(next.coverUrl);
            }
            if (next.artist && next.title) {
              void fetchSyncedLyrics(next.artist, next.title, next.durationMs);
            }
          });
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
    let lastInterlude = false;
    let lastShowUpNext = false;
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

      // 2. Timecode DOM update only once per second + Up Next banner window (last 14s)
      const curSec = Math.floor(liveMs / 1000);
      if (curSec !== lastSecond) {
        lastSecond = curSec;
        const tc = timecodeRef.current;
        if (tc) {
          tc.textContent = `${formatTime(liveMs)} / ${formattedDuration}`;
        }
        const remainingMs = durationMs - liveMs;
        const shouldShowNext = clock.isPlaying && remainingMs > 1200 && remainingMs <= 14_000;
        if (shouldShowNext !== lastShowUpNext) {
          lastShowUpNext = shouldShowNext;
          setShowUpNext(shouldShowNext);
        }
      }

      // 3. Frame-accurate lyric line & word trigger + instrumental interlude detection
      if (lyricMode === 'off' || lyrics.length === 0) {
        if (lastLyricKey !== 'off') {
          lastLyricKey = 'off';
          setActiveLyric(null);
        }
        if (lastInterlude) {
          lastInterlude = false;
          setIsInterlude(false);
        }
        return;
      }

      const lyricTimeMs = liveMs + lyricOffsetMs;
      const inGap = isInstrumentalGap(lyrics, lyricTimeMs);
      if (inGap !== lastInterlude) {
        lastInterlude = inGap;
        setIsInterlude(inGap);
      }

      const state = getActiveLyricState(lyrics, lyricTimeMs);
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
  }, [isAuthenticated, lyricMode, lyricOffsetMs, lyrics, track.durationMs, track.id]);

  // Sync demo track when not authenticated
  useEffect(() => {
    if (isAuthenticated) return;
    const demo = DEMO_TRACKS[demoIndex];
    const nextDemo = DEMO_TRACKS[(demoIndex + 1) % DEMO_TRACKS.length];
    lastTrackIdRef.current = demo.id;
    playbackClockRef.current = {
      progressMs: demo.progressMs,
      updatedAt: performance.now(),
      isPlaying: demo.isPlaying,
    };
    setTrack(demo);
    setLyrics(DEMO_LYRICS[demo.id] ?? []);
    setUpNextTrack({
      id: nextDemo.id,
      title: nextDemo.title,
      artist: nextDemo.artist,
      coverUrl: nextDemo.coverUrl,
      durationMs: nextDemo.durationMs,
    });
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

  const handleSeek = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const targetMs = Math.round(ratio * track.durationMs);

      playbackClockRef.current = {
        progressMs: targetMs,
        updatedAt: performance.now(),
        isPlaying: playbackClockRef.current.isPlaying,
      };
      if (progressFillRef.current) {
        progressFillRef.current.style.transform = `scaleX(${ratio.toFixed(4)})`;
      }

      if (isAuthenticated) {
        try {
          await seekSpotifyPlayback(targetMs);
        } catch {
          showNotice('Перемотка недоступна для текущего устройства');
        }
      }
    },
    [isAuthenticated, showNotice, track.durationMs]
  );

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
      } else if (e.code === 'BracketLeft') {
        setLyricOffsetMs((prev) => {
          const next = Math.max(-500, prev - 25);
          showNotice(`Смещение лирики: ${next >= 0 ? `+${next}` : next} мс`, 1400);
          return next;
        });
      } else if (e.code === 'BracketRight') {
        setLyricOffsetMs((prev) => {
          const next = Math.min(500, prev + 25);
          showNotice(`Смещение лирики: ${next >= 0 ? `+${next}` : next} мс`, 1400);
          return next;
        });
      } else if (e.code === 'Escape') {
        setHelpOpen(false);
        setTuneOpen(false);
      } else if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
        setHelpOpen((v) => !v);
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
    showNotice,
    toggleMic,
    toggleSystemAudio,
  ]);

  // Media Session API: hardware media keys & remote controls
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: track.coverUrl ? [{ src: track.coverUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.playbackState = track.isPlaying ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', () => {
        if (!track.isPlaying) void handlePlayPause();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (track.isPlaying) void handlePlayPause();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        void handleNext();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        void handlePrev();
      });
    } catch {
      // Some browsers restrict MediaSession handlers
    }
  }, [handleNext, handlePlayPause, handlePrev, track.album, track.artist, track.coverUrl, track.isPlaying, track.title]);

  const getMetrics = useCallback((t: number, playing: boolean) => {
    return analyzerRef.current!.sample(t, playing);
  }, []);

  const handleMetricsFrame = useCallback(
    (metrics: {
      beat: number;
      bass: number;
      mid: number;
      treble: number;
      energy: number;
      bpm: number;
      beatCount: number;
      audioSource: AudioSourceType;
    }) => {
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

      const vu = vuMeterRef.current;
      if (vu) {
        vu.style.transform = `scaleX(${Math.min(1, Math.max(0.03, metrics.energy)).toFixed(3)})`;
      }
      const bpmEl = bpmTagRef.current;
      if (bpmEl) {
        const nextText = metrics.bpm > 0 ? `${metrics.bpm} BPM` : '— BPM';
        if (bpmEl.textContent !== nextText) {
          bpmEl.textContent = nextText;
        }
      }

      // Beat-locked Auto VJ scene switch on 32-beat phrases or strong drops (min 14s cooldown)
      if (biomeChoice === 'auto' && metrics.audioSource !== 'none') {
        const now = Date.now();
        const phraseSwitch =
          metrics.beatCount > 0 &&
          metrics.beatCount !== lastBeatSwitchCountRef.current &&
          metrics.beatCount % 32 === 0;
        const dropSwitch = metrics.beat > 0.74 && metrics.bass > 0.5;
        if ((phraseSwitch || dropSwitch) && now - lastVjSwitchRef.current >= 14_000) {
          lastVjSwitchRef.current = now;
          lastBeatSwitchCountRef.current = metrics.beatCount;
          setVjStep((s) => s + 1);
        }
      }
    },
    [biomeChoice]
  );

  const hideCursor = !hudVisible && !hudPinned && !modalOpen && !tuneOpen;

  return (
    <main className={`stage-root ${hideCursor ? 'is-idle-cursor' : ''} ${oledDimmed ? 'is-oled-dim' : ''}`}>
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

      {/* Dedicated Editorial Reels Typography Stage (when 'Type' scene is active & kinetic mode is on) */}
      {resolvedBiome === 'kinetic-type' && !titleCardTrack && lyricMode === 'kinetic' && (
        <KineticTypeStage
          track={effectiveTrack}
          activeLyric={activeLyric}
          isInterlude={isInterlude}
          beatRef={lyricsOverlayRef}
          clockRef={playbackClockRef}
          showBall={bouncingBall}
          fontStyle={fontStyle}
          lyricOffsetMs={lyricOffsetMs}
        />
      )}

      {/* Instrumental Interlude Beat Dots over WebGL scenes (and Type scene in scroll mode) */}
      {!(resolvedBiome === 'kinetic-type' && lyricMode === 'kinetic') &&
        isInterlude &&
        !titleCardTrack &&
        lyricMode !== 'off' && (
          <div
            ref={lyricsOverlayRef}
            className={`interlude-dots ${fontStyle === 'pixel' ? 'is-pixel-font' : ''}`}
            style={
              {
                '--lyric-accent': effectiveTrack.palette.accent,
                '--lyric-primary': effectiveTrack.palette.primary,
              } as React.CSSProperties
            }
            aria-hidden="true"
          >
            <span className="interlude-dot" />
            <span className="interlude-dot" />
            <span className="interlude-dot" />
          </div>
        )}

      {/* Lyrics Overlay: Kinetic Mode OR 5-Line Depth-of-Field Scroll Mode */}
      {resolvedBiome !== 'kinetic-type' &&
        activeLyric &&
        !isInterlude &&
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
              lyricOffsetMs={lyricOffsetMs}
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

      {activeLyric &&
        !isInterlude &&
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
          <p className="scroll-line is-prev-far">{activeLyric.prev2Text ?? '\u00A0'}</p>
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
              lyricOffsetMs={lyricOffsetMs}
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
          <p className="scroll-line is-next-far">{activeLyric.next2Text ?? '\u00A0'}</p>
        </div>
      )}

      {/* Up Next cinematic corner card in the last 14s of a track */}
      {showUpNext && upNextTrack && !titleCardTrack && (
        <aside className="up-next-card" aria-label="Следующий трек">
          {upNextTrack.coverUrl && (
            <img src={upNextTrack.coverUrl} alt="" className="up-next-cover" />
          )}
          <div className="up-next-meta">
            <span className="up-next-kicker">ДАЛЕЕ</span>
            <strong className="up-next-title">{upNextTrack.title}</strong>
            <span className="up-next-artist">{upNextTrack.artist}</span>
          </div>
        </aside>
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
            <div
              className="progress-track is-seekable"
              onClick={handleSeek}
              title="Нажмите для перемотки"
            >
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
                <div className="tune-label-row">
                  <span className="tune-label">Уровень звука ({audioSource === 'none' ? 'нет сигнала' : audioSource})</span>
                  <span ref={bpmTagRef} className="tune-bpm-badge">— BPM</span>
                </div>
                <div className="vu-meter-track" aria-hidden="true">
                  <div
                    ref={vuMeterRef}
                    className="vu-meter-fill"
                    style={{ backgroundColor: effectiveTrack.palette.accent }}
                  />
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
              <div className="tune-group">
                <span className="tune-label">
                  Смещение лирики ({lyricOffsetMs >= 0 ? `+${lyricOffsetMs}` : lyricOffsetMs} мс)
                </span>
                <input
                  type="range"
                  min={-500}
                  max={500}
                  step={25}
                  value={lyricOffsetMs}
                  onChange={(e) => setLyricOffsetMs(Number(e.target.value))}
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
                className={`icon-btn ${helpOpen ? 'is-active-pill' : ''}`}
                onClick={() => setHelpOpen((v) => !v)}
                title="Горячие клавиши (?)"
              >
                <HelpCircle size={16} />
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

      {helpOpen && (
        <div className="shortcuts-backdrop" onClick={() => setHelpOpen(false)}>
          <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-header">
              <h2>Горячие клавиши</h2>
              <button
                type="button"
                className="dock-tab"
                onClick={() => setHelpOpen(false)}
              >
                Esc
              </button>
            </div>
            <div className="shortcuts-grid">
              <div><kbd>0</kbd><span>Режим Auto VJ (в такт биту)</span></div>
              <div><kbd>1</kbd>–<kbd>6</kbd><span>Выбор сцены (Ocean … Type)</span></div>
              <div><kbd>Space</kbd><span>Пауза / воспроизведение</span></div>
              <div><kbd>A</kbd><span>Захват звука вкладки / системы</span></div>
              <div><kbd>M</kbd><span>Микрофон</span></div>
              <div><kbd>L</kbd><span>Режим субтитров</span></div>
              <div><kbd>F</kbd><span>Шрифт (Pixel / Editorial / Brutal)</span></div>
              <div><kbd>[</kbd> / <kbd>]</kbd><span>Смещение лирики ±25 мс</span></div>
              <div><kbd>G</kbd><span>Палитры, Gain, VU-метр и Offset</span></div>
              <div><kbd>S</kbd><span>Сохранить арт-постер в PNG</span></div>
              <div><kbd>H</kbd><span>Закрепить / скрыть HUD</span></div>
              <div><kbd>?</kbd><span>Показать / скрыть эту справку</span></div>
            </div>
          </div>
        </div>
      )}

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
