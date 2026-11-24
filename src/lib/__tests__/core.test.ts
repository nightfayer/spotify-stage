import { describe, expect, it } from 'vitest';
import {
  buildPlainLyrics,
  cleanTrackTitle,
  getActiveLyricState,
  parseLrc,
} from '../lyrics';
import { ensureReadablePalette, resolveBiomeForGenres } from '../palette';

describe('lyrics utilities', () => {
  it('parses synced LRC lines and sorts chronologically', () => {
    const lrc = `
      [00:12.50] Second line
      [00:05.125] First line
      [00:15.00]
    `;
    const parsed = parseLrc(lrc);
    expect(parsed).toEqual([
      { timeMs: 5125, text: 'First line' },
      { timeMs: 12500, text: 'Second line' },
    ]);
  });

  it('cleans remaster, feat, and radio edit suffixes from track titles', () => {
    expect(cleanTrackTitle('Bohemian Rhapsody - Remastered 2011')).toBe('Bohemian Rhapsody');
    expect(cleanTrackTitle('Starboy (feat. Daft Punk) [Radio Edit]')).toBe('Starboy');
    expect(cleanTrackTitle('Dreams - 2004 Remaster')).toBe('Dreams');
  });

  it('finds active line and word index via binary search', () => {
    const lines = [
      { timeMs: 1000, text: 'Hello bright world' },
      { timeMs: 4000, text: 'Next verse here' },
    ];
    const state = getActiveLyricState(lines, 2500);
    expect(state).not.toBeNull();
    expect(state?.index).toBe(0);
    expect(state?.nextText).toBe('Next verse here');
    expect(state?.words).toEqual(['Hello', 'bright', 'world']);
    expect(state?.activeWordIndex).toBeGreaterThanOrEqual(1);
  });

  it('distributes plainLyrics across playable track duration', () => {
    const lines = buildPlainLyrics('[Verse 1]\nLine one\n\nLine two\nLine three', 100_000);
    expect(lines).toHaveLength(3);
    expect(lines[0].timeMs).toBe(6000);
    expect(lines[2].timeMs).toBeGreaterThan(lines[1].timeMs);
    expect(lines[2].timeMs).toBeLessThan(92_000);
  });
});

describe('palette utilities', () => {
  it('lifts dark colors and darkens bright backgrounds for readability', () => {
    const safe = ensureReadablePalette({
      primary: '#050508',
      secondary: '#0a0a0f',
      accent: '#101018',
      background: '#f5f5f5',
    });
    expect(safe.background).not.toBe('#f5f5f5');
    expect(safe.primary).not.toBe('#050508');
    expect(safe.accent).not.toBe('#101018');
  });

  it('maps genres to appropriate default biomes', () => {
    expect(resolveBiomeForGenres(['lo-fi', 'chill'])).toBe('pixel-horizon');
    expect(resolveBiomeForGenres(['metal', 'rock'])).toBe('pixel-plasma');
    expect(resolveBiomeForGenres(['synthwave', 'techno'])).toBe('pixel-tunnel');
    expect(resolveBiomeForGenres(['classical'])).toBe('pixel-kaleido');
  });
});
