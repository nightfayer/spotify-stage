import type { LyricLine, TrackState } from '../types';

function makeCoverArtDataUrl(c1: string, c2: string, c3: string, label: string): string {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${c1}" />
          <stop offset="55%" stop-color="${c2}" />
          <stop offset="100%" stop-color="${c3}" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" fill="url(#g)" />
      <circle cx="256" cy="240" r="130" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="2" />
      <circle cx="256" cy="240" r="80" fill="rgba(255,255,255,0.12)" />
      <text x="40" y="458" font-family="system-ui, sans-serif" font-size="22" letter-spacing="4" fill="rgba(255,255,255,0.75)">${label}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const DEMO_TRACKS: TrackState[] = [
  {
    id: 'demo-cyber',
    title: 'Nightcall Overdrive',
    artist: 'Kavinsky & Neon Grid',
    album: 'OutRun Sessions',
    coverUrl: makeCoverArtDataUrl('#0f172a', '#e11d48', '#22d3ee', 'CYBER TERRAIN'),
    genres: ['synthwave', 'electronic'],
    durationMs: 215_000,
    progressMs: 42_000,
    isPlaying: true,
    palette: {
      primary: '#22d3ee',
      secondary: '#e11d48',
      accent: '#fde047',
      background: '#080c18',
    },
  },
  {
    id: 'demo-chrome',
    title: 'Velvet Meridian',
    artist: 'Kelela & Blood Orange',
    album: 'Liquid Forms',
    coverUrl: makeCoverArtDataUrl('#1c1917', '#f59e0b', '#fb7185', 'LIQUID CHROME'),
    genres: ['r&b', 'hip hop'],
    durationMs: 192_000,
    progressMs: 65_000,
    isPlaying: true,
    palette: {
      primary: '#f59e0b',
      secondary: '#fb7185',
      accent: '#fef3c7',
      background: '#110d0b',
    },
  },
  {
    id: 'demo-nebula',
    title: 'Driftwood Horizon',
    artist: 'Olafur Arnalds & Nils Frahm',
    album: 'Quiet Atmosphere',
    coverUrl: makeCoverArtDataUrl('#052e16', '#34d399', '#60a5fa', 'NEBULA WAVES'),
    genres: ['ambient', 'lo-fi'],
    durationMs: 248_000,
    progressMs: 18_000,
    isPlaying: true,
    palette: {
      primary: '#34d399',
      secondary: '#60a5fa',
      accent: '#a7f3d0',
      background: '#051210',
    },
  },
];

export const DEMO_LYRICS: Record<string, LyricLine[]> = {
  'demo-cyber': [
    { timeMs: 0, text: 'Sodium streetlights blur across the glass' },
    { timeMs: 6000, text: 'Horizon lines bending into signal' },
    { timeMs: 12000, text: 'Hold the frequency until the static clears' },
    { timeMs: 18000, text: 'Midnight telemetry on an empty highway' },
    { timeMs: 24000, text: 'Every pulse reflected in the chrome' },
  ],
  'demo-chrome': [
    { timeMs: 0, text: 'Amber light across the studio floor' },
    { timeMs: 6000, text: 'Slow-motion gravity in the low end' },
    { timeMs: 12000, text: 'Reflections folding into liquid gold' },
    { timeMs: 18000, text: 'Stay in the pocket of the bassline' },
  ],
  'demo-nebula': [
    { timeMs: 0, text: 'Soft rain over the northern coast' },
    { timeMs: 6000, text: 'Echoes drifting through open air' },
    { timeMs: 12000, text: 'Nothing rushing, only slow tide' },
    { timeMs: 18000, text: 'Light settling on quiet water' },
  ],
};
