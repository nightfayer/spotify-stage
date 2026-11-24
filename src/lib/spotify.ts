const STORAGE_KEYS = {
  clientId: 'spotify_stage_client_id',
  verifier: 'spotify_stage_pkce_verifier',
  accessToken: 'spotify_stage_access_token',
  refreshToken: 'spotify_stage_refresh_token',
  expiresAt: 'spotify_stage_expires_at',
};

const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

export function getRedirectUri(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

export function getSavedClientId(): string {
  return localStorage.getItem(STORAGE_KEYS.clientId) ?? '';
}

export function saveClientId(clientId: string): void {
  localStorage.setItem(STORAGE_KEYS.clientId, clientId.trim());
}

export function isSpotifyAuthenticated(): boolean {
  return Boolean(localStorage.getItem(STORAGE_KEYS.accessToken));
}

export function disconnectSpotify(): void {
  localStorage.removeItem(STORAGE_KEYS.accessToken);
  localStorage.removeItem(STORAGE_KEYS.refreshToken);
  localStorage.removeItem(STORAGE_KEYS.expiresAt);
  localStorage.removeItem(STORAGE_KEYS.verifier);
}

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startSpotifyLogin(clientId: string): Promise<void> {
  const cleanId = clientId.trim();
  if (!cleanId) throw new Error('Client ID is required');

  saveClientId(cleanId);
  const verifier = generateRandomString(64);
  localStorage.setItem(STORAGE_KEYS.verifier, verifier);

  const challenge = base64UrlEncode(await sha256(verifier));
  const params = new URLSearchParams({
    client_id: cleanId,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function handleSpotifyCallbackIfPresent(): Promise<boolean> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    url.searchParams.delete('error');
    window.history.replaceState({}, document.title, url.toString());
    throw new Error(`Spotify authorization error: ${error}`);
  }

  if (!code) return false;

  const clientId = getSavedClientId();
  const verifier = localStorage.getItem(STORAGE_KEYS.verifier);

  // Clean URL immediately regardless of outcome
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, document.title, url.toString());

  if (!clientId || !verifier) {
    throw new Error('Missing PKCE session state. Please reconnect Spotify.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status})`);
  }

  const data = await res.json();
  storeTokens(data);
  return true;
}

function storeTokens(data: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}): void {
  localStorage.setItem(STORAGE_KEYS.accessToken, data.access_token);
  if (data.refresh_token) {
    localStorage.setItem(STORAGE_KEYS.refreshToken, data.refresh_token);
  }
  const expiresAt = Date.now() + data.expires_in * 1000 - 30_000;
  localStorage.setItem(STORAGE_KEYS.expiresAt, String(expiresAt));
}

async function getValidAccessToken(): Promise<string | null> {
  const token = localStorage.getItem(STORAGE_KEYS.accessToken);
  if (!token) return null;

  const expiresAt = Number(localStorage.getItem(STORAGE_KEYS.expiresAt) ?? '0');
  if (Date.now() < expiresAt) return token;

  const refreshToken = localStorage.getItem(STORAGE_KEYS.refreshToken);
  const clientId = getSavedClientId();
  if (!refreshToken || !clientId) {
    disconnectSpotify();
    return null;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    disconnectSpotify();
    return null;
  }

  const data = await res.json();
  storeTokens(data);
  return data.access_token;
}

const artistGenreCache = new Map<string, string[]>();

async function fetchArtistGenres(artistId: string, token: string): Promise<string[]> {
  const cached = artistGenreCache.get(artistId);
  if (cached) return cached;

  try {
    const res = await fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const genres = Array.isArray(data.genres) ? data.genres : [];
    artistGenreCache.set(artistId, genres);
    return genres;
  } catch {
    return [];
  }
}

export interface SpotifyPlaybackSnapshot {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  genres: string[];
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  /** performance.now() timestamp when progressMs was measured (RTT-compensated) */
  sampledAt: number;
}

export async function fetchSpotifyPlayback(signal?: AbortSignal): Promise<SpotifyPlaybackSnapshot | null> {
  const token = await getValidAccessToken();
  if (!token) return null;

  const reqStart = performance.now();
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  const reqEnd = performance.now();

  if (res.status === 204 || res.status === 404) {
    return null;
  }

  if (res.status === 401) {
    disconnectSpotify();
    throw new Error('Spotify session expired');
  }

  if (!res.ok) {
    throw new Error(`Spotify API error (${res.status})`);
  }

  const data = await res.json();
  const item = data?.item;
  if (!item || item.type !== 'track') return null;

  const isPlaying = Boolean(data.is_playing);
  const durationMs = item.duration_ms ?? 180_000;
  // Compensate half of network RTT so playback clock aligns closely with actual audio
  const halfRttMs = isPlaying ? Math.min(400, (reqEnd - reqStart) * 0.5) : 0;
  const rawProgressMs = data.progress_ms ?? 0;
  const progressMs = Math.min(durationMs, rawProgressMs + halfRttMs);

  // Never block playback snapshot on genre lookup: use cache immediately or warm cache in background
  const primaryArtistId: string | undefined = item.artists?.[0]?.id;
  let genres: string[] = [];
  if (primaryArtistId) {
    const cached = artistGenreCache.get(primaryArtistId);
    if (cached) {
      genres = cached;
    } else {
      void fetchArtistGenres(primaryArtistId, token);
    }
  }

  const images = item.album?.images ?? [];
  const coverUrl = images[0]?.url ?? null;

  return {
    id: item.id,
    title: item.name,
    artist: item.artists?.map((a: { name: string }) => a.name).join(', ') ?? 'Unknown Artist',
    album: item.album?.name ?? '',
    coverUrl,
    genres,
    durationMs,
    progressMs,
    isPlaying,
    sampledAt: reqEnd,
  };
}

export async function controlSpotifyPlayback(
  action: 'play' | 'pause' | 'next' | 'previous'
): Promise<void> {
  const token = await getValidAccessToken();
  if (!token) return;

  const endpointMap = {
    play: { method: 'PUT', url: 'https://api.spotify.com/v1/me/player/play' },
    pause: { method: 'PUT', url: 'https://api.spotify.com/v1/me/player/pause' },
    next: { method: 'POST', url: 'https://api.spotify.com/v1/me/player/next' },
    previous: { method: 'POST', url: 'https://api.spotify.com/v1/me/player/previous' },
  } as const;

  const { method, url } = endpointMap[action];
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Spotify playback error (${res.status})`);
  }
}
