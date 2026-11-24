import { describe, expect, it } from 'vitest';
import { boxesOverlap, layoutLineInWorld } from '../kineticLayout';
import {
  buildPlainLyrics,
  cleanTrackTitle,
  getActiveLyricState,
  isInstrumentalGap,
  normalizeForMatch,
  parseLrc,
} from '../lyrics';
import { boostVibrantColor, ensureReadablePalette, resolveBiomeForGenres } from '../palette';

describe('lyrics utilities', () => {
  it('parses synced LRC lines including multi-timestamp choruses and 1-digit minutes', () => {
    const lrc = `
      [00:12.50][01:05.00] Припев строки
      [0:05.125] First line
      [00:15.00]
    `;
    const parsed = parseLrc(lrc);
    expect(parsed).toEqual([
      { timeMs: 5125, text: 'First line' },
      { timeMs: 12500, text: 'Припев строки' },
      { timeMs: 65000, text: 'Припев строки' },
    ]);
  });

  it('transliterates Cyrillic artists to match Latinized Spotify names', () => {
    expect(normalizeForMatch('Скриптонит')).toBe(normalizeForMatch('Skriptonit'));
    expect(normalizeForMatch('Кино')).toBe(normalizeForMatch('KINO'));
    expect(normalizeForMatch('Баста')).toBe(normalizeForMatch('Basta'));
    expect(normalizeForMatch('Егор Крид')).toBe(normalizeForMatch('Egor Kreed'));
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

  it('detects intro and mid-track instrumental gaps for beat dots', () => {
    const lines = [
      { timeMs: 8000, text: 'First verse' },
      { timeMs: 22000, text: 'After instrumental break' },
    ];
    expect(isInstrumentalGap(lines, 2000)).toBe(true);
    expect(isInstrumentalGap(lines, 7800)).toBe(false);
    expect(isInstrumentalGap(lines, 9000)).toBe(false);
    expect(isInstrumentalGap(lines, 15000)).toBe(true);
    expect(isInstrumentalGap(lines, 21700)).toBe(false);
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

  it('boosts desaturated or gray colors for vivid inverted Type backdrops', () => {
    const vivid = boostVibrantColor('#808080');
    expect(vivid).toMatch(/^#[0-9a-f]{6}$/i);
    expect(vivid.toLowerCase()).not.toBe('#808080');
  });

  it('maps genres to appropriate default biomes', () => {
    expect(resolveBiomeForGenres(['lo-fi', 'chill'])).toBe('pixel-horizon');
    expect(resolveBiomeForGenres(['metal', 'rock'])).toBe('pixel-plasma');
    expect(resolveBiomeForGenres(['synthwave', 'techno'])).toBe('pixel-tunnel');
    expect(resolveBiomeForGenres(['classical'])).toBe('pixel-kaleido');
  });
});

describe('kinetic 2D camera layout (zero overlap guarantee)', () => {
  it('places short and long English & Russian lines with zero AABB collisions across all rotation patterns', () => {
    const sampleLines = [
      ['tell', 'me', 'what', 'you', 'want', 'what', 'you', 'like'],
      ['я', 'чувствую', 'прикосновение', 'бесконечности', 'в', 'этой', 'ночи'],
      ['im', 'a', 'little', 'curious', 'too!'],
      ['невероятно', 'громкий', 'припев', 'разрывает', 'тишину', 'вокруг', 'нас'],
    ];

    for (let lineIdx = 0; lineIdx < 8; lineIdx++) {
      const words = sampleLines[lineIdx % sampleLines.length];
      const placed = layoutLineInWorld(words, lineIdx, 'test-track');
      expect(placed).toHaveLength(words.length);

      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          expect(
            boxesOverlap(placed[i].box, placed[j].box, 0),
            `Overlap detected on line ${lineIdx} between "${placed[i].word}" and "${placed[j].word}"`
          ).toBe(false);
        }
      }
    }
  });
});
