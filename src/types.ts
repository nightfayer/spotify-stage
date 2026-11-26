export type BiomeId =
  | 'auto'
  | 'pixel-horizon'
  | 'pixel-plasma'
  | 'pixel-tunnel'
  | 'pixel-kaleido'
  | 'pixel-echo'
  | 'pixel-scope'
  | 'kinetic-type';

export type ResolvedBiome = Exclude<BiomeId, 'auto'>;

export type PalettePresetId = 'cover' | 'gameboy' | 'sunset' | 'cyber' | 'crimson';

export type LyricMode = 'kinetic' | 'scroll' | 'off';

export type FontStyleMode = 'pixel' | 'editorial' | 'brutal';

export interface TrackPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
}

export interface LyricLine {
  timeMs: number;
  text: string;
}

export interface TrackState {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  genres: string[];
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  palette: TrackPalette;
}

export type AudioSourceType = 'none' | 'mic' | 'system';

export interface AudioMetrics {
  bass: number;
  mid: number;
  treble: number;
  energy: number;
  beat: number;
  bpm: number;
  beatCount: number;
  audioSource: AudioSourceType;
  spectrum: Uint8Array;
}
