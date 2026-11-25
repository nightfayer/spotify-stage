import type { LyricLine } from '../types';

const LRC_TAG_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(lrcText: string): LyricLine[] {
  const lines: LyricLine[] = [];

  for (const rawLine of lrcText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const timestamps: number[] = [];
    let match: RegExpExecArray | null;
    LRC_TAG_RE.lastIndex = 0;
    while ((match = LRC_TAG_RE.exec(trimmed)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const rawFrac = match[3] ?? '0';
      const frac =
        rawFrac.length === 1
          ? Number(rawFrac) * 100
          : rawFrac.length === 2
            ? Number(rawFrac) * 10
            : Number(rawFrac);
      timestamps.push(minutes * 60_000 + seconds * 1000 + frac);
    }

    if (timestamps.length === 0) continue;
    const text = trimmed.replace(LRC_TAG_RE, '').trim();
    if (!text) continue;

    for (const timeMs of timestamps) {
      lines.push({ timeMs, text });
    }
  }

  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Normalizes Cyrillic & Latin strings to a common lowercase ASCII form so
 * Spotify Latinized Russian artists ("Skriptonit", "KINO", "Basta") match
 * Cyrillic LRCLIB entries ("Скриптонит", "Кино", "Баста").
 */
export function normalizeForMatch(input: string): string {
  let out = '';
  for (const ch of input.toLowerCase()) {
    out += CYR_TO_LAT[ch] ?? ch;
  }
  return out
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/c(?=[ei])/g, 's')
    .replace(/c/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/y/g, 'i')
    .replace(/kh/g, 'h')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function artistMatches(spotifyArtist: string, candidateArtist: string): boolean {
  const normCand = normalizeForMatch(candidateArtist);
  if (!normCand) return false;

  // Split multi-artist credits ("Miyagi & Эндшпиль", "Баста, Скриптонит", "A x B")
  const parts = spotifyArtist
    .split(/,|&|\bx\b|\bfeat\.?\b|\bft\.?\b|\bпри уч\.?\b/i)
    .map((p) => normalizeForMatch(p))
    .filter((p) => p.length >= 2);

  if (parts.length === 0) return false;
  return parts.some((p) => normCand.includes(p) || p.includes(normCand));
}

interface LrcLibItem {
  trackName?: string;
  artistName?: string;
  duration?: number;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

function pickBestResult(
  results: LrcLibItem[],
  spotifyArtist: string,
  cleanedTitle: string,
  durationSec: number
): { syncedLyrics: string | null; plainLyrics: string | null } {
  const normTitle = normalizeForMatch(cleanedTitle);

  const scoreItem = (item: LrcLibItem): number => {
    const durDiff = Math.abs((item.duration ?? durationSec) - durationSec);
    const hasArtist = item.artistName ? artistMatches(spotifyArtist, item.artistName) : false;
    const normItemTitle = item.trackName ? normalizeForMatch(cleanTrackTitle(item.trackName)) : '';
    const titleExact = normTitle.length > 0 && normItemTitle === normTitle;
    const titleContains =
      normTitle.length > 0 &&
      (normItemTitle.includes(normTitle) || normTitle.includes(normItemTitle));

    // Always require artist match so unrelated songs sharing a common title (e.g. "Риски") never bleed in
    if (!hasArtist) return -1;
    if (!titleExact && !titleContains) return -1;
    if (durDiff > 18) return -1;

    let score = 50;
    if (titleExact) score += 30;
    else if (titleContains) score += 15;
    if (durDiff <= 2) score += 25;
    else if (durDiff <= 5) score += 15;
    else if (durDiff <= 10) score += 5;
    return score;
  };

  const scored = results
    .map((item) => ({ item, score: scoreItem(item) }))
    .filter((x) => x.score >= 30)
    .sort((a, b) => b.score - a.score);

  const bestSynced = scored.find(
    (x) => typeof x.item.syncedLyrics === 'string' && x.item.syncedLyrics.trim().length > 0
  );
  if (bestSynced?.item.syncedLyrics) {
    return { syncedLyrics: bestSynced.item.syncedLyrics, plainLyrics: null };
  }

  const bestPlain = scored.find(
    (x) => typeof x.item.plainLyrics === 'string' && x.item.plainLyrics.trim().length > 0
  );
  return { syncedLyrics: null, plainLyrics: bestPlain?.item.plainLyrics ?? null };
}

const lyricsCache = new Map<string, LyricLine[]>();

export function cleanTrackTitle(raw: string): string {
  return raw
    .replace(/\s*\((?:feat\.?|ft\.?|with|при уч\.?|remaster(?:ed)?|live|acoustic|deluxe|radio edit|bonus track|version|edit|mono|stereo)[^)]*\)/gi, '')
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

async function fetchWithTimeout(
  url: string,
  signal?: AbortSignal,
  timeoutMs = 5000
): Promise<Response> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function queryLrcGet(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<LrcLibItem | null> {
  try {
    const res = await fetchWithTimeout(
      `https://lrclib.net/api/get?${params.toString()}`,
      signal,
      5000
    );
    if (!res.ok) return null;
    return (await res.json()) as LrcLibItem;
  } catch {
    return null;
  }
}

async function queryLrcSearch(params: URLSearchParams, signal?: AbortSignal): Promise<LrcLibItem[]> {
  try {
    const res = await fetchWithTimeout(
      `https://lrclib.net/api/search?${params.toString()}`,
      signal,
      5000
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as LrcLibItem[]) : [];
  } catch {
    return [];
  }
}

export async function fetchSyncedLyrics(
  artist: string,
  title: string,
  durationMs: number,
  signal?: AbortSignal
): Promise<LyricLine[]> {
  const cleanArtist = artist.split(',')[0].trim();
  const cleanedTitle = cleanTrackTitle(title) || title;
  const durationSec = Math.round(durationMs / 1000);
  const cacheKey = `${cleanArtist.toLowerCase()}::${title.toLowerCase()}::${durationSec}`;
  const cached = lyricsCache.get(cacheKey);
  if (cached) return cached;

  try {
    let fallbackPlain: string | null = null;

    // 1. Fast exact lookup via /api/get (with duration, then without duration / cleaned title)
    const getAttempts: URLSearchParams[] = [
      new URLSearchParams({
        artist_name: cleanArtist,
        track_name: title,
        duration: String(durationSec),
      }),
      new URLSearchParams({
        artist_name: cleanArtist,
        track_name: cleanedTitle,
      }),
    ];

    for (const getParams of getAttempts) {
      if (signal?.aborted) return [];
      const data = await queryLrcGet(getParams, signal);
      if (!data) continue;
      if (typeof data.syncedLyrics === 'string' && data.syncedLyrics.trim()) {
        const parsed = parseLrc(data.syncedLyrics);
        if (parsed.length > 0) {
          lyricsCache.set(cacheKey, parsed);
          return parsed;
        }
      }
      if (!fallbackPlain && typeof data.plainLyrics === 'string' && data.plainLyrics.trim()) {
        fallbackPlain = data.plainLyrics;
      }
    }

    // 2. Structured search with cleaned title & primary artist
    if (!signal?.aborted) {
      const structuredResults = await queryLrcSearch(
        new URLSearchParams({ artist_name: cleanArtist, track_name: cleanedTitle }),
        signal
      );
      if (structuredResults.length > 0) {
        const picked = pickBestResult(structuredResults, artist, cleanedTitle, durationSec);
        if (picked.syncedLyrics) {
          const parsed = parseLrc(picked.syncedLyrics);
          lyricsCache.set(cacheKey, parsed);
          return parsed;
        }
        if (!fallbackPlain && picked.plainLyrics) fallbackPlain = picked.plainLyrics;
      }
    }

    // 3. Combined full-text search (artist + title) — crucial for common titles & collabs/features
    const allArtists = artist
      .split(/,|&|\bx\b/i)
      .map((a) => a.trim())
      .filter(Boolean);
    const searchQueries = [`${cleanArtist} ${cleanedTitle}`];
    if (allArtists.length > 1) {
      searchQueries.push(`${allArtists[1]} ${cleanedTitle}`);
    }
    searchQueries.push(cleanedTitle);

    for (const q of searchQueries) {
      if (signal?.aborted) return [];
      const results = await queryLrcSearch(new URLSearchParams({ q }), signal);
      if (results.length === 0) continue;
      const picked = pickBestResult(results, artist, cleanedTitle, durationSec);
      if (picked.syncedLyrics) {
        const parsed = parseLrc(picked.syncedLyrics);
        lyricsCache.set(cacheKey, parsed);
        return parsed;
      }
      if (!fallbackPlain && picked.plainLyrics) fallbackPlain = picked.plainLyrics;
    }

    if (fallbackPlain) {
      const synthetic = buildPlainLyrics(fallbackPlain, durationMs);
      lyricsCache.set(cacheKey, synthetic);
      return synthetic;
    }

    return [];
  } catch {
    return [];
  }
}

export interface ActiveLyricState {
  index: number;
  text: string;
  prev2Text: string | null;
  prevText: string | null;
  nextText: string | null;
  next2Text: string | null;
  words: string[];
  activeWordIndex: number;
  lineStartMs: number;
  lineDurationMs: number;
}

/**
 * Returns true when playback is in an intro (>3.5s before first line) or
 * an instrumental interlude gap between vocal lines (for Apple Music Sing-style beat dots).
 */
export function isInstrumentalGap(lines: LyricLine[], progressMs: number): boolean {
  if (lines.length === 0) return false;

  const firstTime = lines[0].timeMs;
  if (progressMs < firstTime) {
    return firstTime >= 3500 && firstTime - progressMs > 600;
  }

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

  if (activeIdx === -1 || activeIdx + 1 >= lines.length) return false;
  const current = lines[activeIdx];
  const next = lines[activeIdx + 1];
  const gap = next.timeMs - current.timeMs;
  if (gap < 7500) return false;

  const elapsed = progressMs - current.timeMs;
  const remaining = next.timeMs - progressMs;
  return elapsed > 4800 && remaining > 650;
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
    prev2Text: activeIdx > 1 ? lines[activeIdx - 2].text : null,
    prevText: activeIdx > 0 ? lines[activeIdx - 1].text : null,
    nextText: activeIdx + 1 < lines.length ? lines[activeIdx + 1].text : null,
    next2Text: activeIdx + 2 < lines.length ? lines[activeIdx + 2].text : null,
    words,
    activeWordIndex,
    lineStartMs: current.timeMs,
    lineDurationMs: span,
  };
}
