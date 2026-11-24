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

const lyricsCache = new Map<string, LyricLine[]>();

export function cleanTrackTitle(raw: string): string {
  return raw
    .replace(/\s*\((?:feat\.?|ft\.?|with|remaster(?:ed)?|live|acoustic|deluxe|radio edit|bonus track|version|edit|mono|stereo)[^)]*\)/gi, '')
    .replace(/\s*\[[^\]]*(?:remaster|live|edit|feat|ft|version|deluxe)[^\]]*\]/gi, '')
    .replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|single version|radio edit|live|acoustic|mono|stereo).*$/i, '')
    .trim();
}

/**
 * Fallback when LRCLIB only has unsynced plainLyrics: evenly distributes non-empty lines
 * across the playable body of the track so the screen never stays blank.
 */
export function buildPlainLyrics(plainText: string, durationMs: number): LyricLine[] {
  const rawLines = plainText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\[.*\]$/.test(l));
  if (rawLines.length === 0) return [];

  const safeDuration = Math.max(30_000, durationMs);
  const startMs = Math.round(safeDuration * 0.06);
  const endMs = Math.round(safeDuration * 0.92);
  const stepMs = (endMs - startMs) / rawLines.length;

  return rawLines.map((text, idx) => ({
    timeMs: Math.round(startMs + idx * stepMs),
    text,
  }));
}

export async function fetchSyncedLyrics(
  artist: string,
  title: string,
  durationMs: number,
  signal?: AbortSignal
): Promise<LyricLine[]> {
  const cleanArtist = artist.split(',')[0].trim();
  const durationSec = Math.round(durationMs / 1000);
  const cacheKey = `${cleanArtist.toLowerCase()}::${title.toLowerCase()}::${durationSec}`;
  const cached = lyricsCache.get(cacheKey);
  if (cached) return cached;

  try {
    let fallbackPlain: string | null = null;

    // 1. Exact lookup via /api/get
    const params = new URLSearchParams({
      artist_name: cleanArtist,
      track_name: title,
      duration: String(durationSec),
    });

    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, { signal });
    if (res.ok) {
      const data = await res.json();
      if (data?.syncedLyrics) {
        const parsed = parseLrc(data.syncedLyrics);
        lyricsCache.set(cacheKey, parsed);
        return parsed;
      }
      if (typeof data?.plainLyrics === 'string' && data.plainLyrics.trim()) {
        fallbackPlain = data.plainLyrics;
      }
    }

    // 2. Fallback search with cleaned track title (handles "(Remastered 2011)", "(feat. ...)", etc.)
    const cleanedTitle = cleanTrackTitle(title) || title;
    const searchParams = new URLSearchParams({
      artist_name: cleanArtist,
      track_name: cleanedTitle,
    });
    const searchRes = await fetch(`https://lrclib.net/api/search?${searchParams.toString()}`, {
      signal,
    });
    if (searchRes.ok) {
      const results = await searchRes.json();
      if (Array.isArray(results)) {
        const withSynced = results.filter(
          (item: { syncedLyrics?: string; duration?: number }) =>
            typeof item?.syncedLyrics === 'string' && item.syncedLyrics.trim().length > 0
        );
        if (withSynced.length > 0) {
          withSynced.sort(
            (a: { duration?: number }, b: { duration?: number }) =>
              Math.abs((a.duration ?? durationSec) - durationSec) -
              Math.abs((b.duration ?? durationSec) - durationSec)
          );
          const parsed = parseLrc(withSynced[0].syncedLyrics);
          lyricsCache.set(cacheKey, parsed);
          return parsed;
        }
        if (!fallbackPlain) {
          const withPlain = results.find(
            (item: { plainLyrics?: string }) =>
              typeof item?.plainLyrics === 'string' && item.plainLyrics.trim().length > 0
          );
          if (withPlain) fallbackPlain = withPlain.plainLyrics;
        }
      }
    }

    if (fallbackPlain) {
      const synthetic = buildPlainLyrics(fallbackPlain, durationMs);
      lyricsCache.set(cacheKey, synthetic);
      return synthetic;
    }

    lyricsCache.set(cacheKey, []);
    return [];
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

  // Binary search for the latest line with timeMs <= progressMs
  let lo = 0;
  let hi = lines.length - 1;
  let activeIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= progressMs) {
      activeIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
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
