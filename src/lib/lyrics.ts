import type { LyricLine } from '../types';

const LRC_LINE_RE = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

export function parseLrc(lrcText: string): LyricLine[] {
  const lines: LyricLine[] = [];

  for (const rawLine of lrcText.split('\n')) {
    const match = LRC_LINE_RE.exec(rawLine.trim());
    if (!match) continue;

    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const frac = match[3].length === 2 ? Number(match[3]) * 10 : Number(match[3]);
    const text = match[4].trim();

    if (!text) continue;
    lines.push({
      timeMs: minutes * 60_000 + seconds * 1000 + frac,
      text,
    });
  }

  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export async function fetchSyncedLyrics(
  artist: string,
  title: string,
  durationMs: number
): Promise<LyricLine[]> {
  try {
    const params = new URLSearchParams({
      artist_name: artist.split(',')[0].trim(),
      track_name: title,
      duration: String(Math.round(durationMs / 1000)),
    });

    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
    if (!res.ok) return [];

    const data = await res.json();
    if (!data?.syncedLyrics) return [];
    return parseLrc(data.syncedLyrics);
  } catch {
    return [];
  }
}

export interface ActiveLyricState {
  index: number;
  text: string;
  prevText: string | null;
  nextText: string | null;
  words: string[];
  activeWordIndex: number;
  lineStartMs: number;
  lineDurationMs: number;
}

export function getActiveLyricState(
  lines: LyricLine[],
  progressMs: number
): ActiveLyricState | null {
  if (lines.length === 0) return null;

  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeMs <= progressMs) {
      activeIdx = i;
    } else {
      break;
    }
  }

  if (activeIdx === -1) return null;

  const current = lines[activeIdx];
  const nextTime = lines[activeIdx + 1]?.timeMs ?? current.timeMs + 4500;
  const span = Math.max(800, Math.min(6000, nextTime - current.timeMs));
  const elapsed = Math.max(0, progressMs - current.timeMs);
  const progress = Math.min(1, elapsed / (span * 0.82));

  const words = current.text.split(/\s+/).filter(Boolean);
  const activeWordIndex = Math.min(
    words.length - 1,
    Math.floor(progress * words.length)
  );

  return {
    index: activeIdx,
    text: current.text,
    prevText: activeIdx > 0 ? lines[activeIdx - 1].text : null,
    nextText: activeIdx + 1 < lines.length ? lines[activeIdx + 1].text : null,
    words,
    activeWordIndex,
    lineStartMs: current.timeMs,
    lineDurationMs: span,
  };
}
