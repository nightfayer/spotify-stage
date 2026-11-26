import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';
import type { AudioMetrics, ResolvedBiome, TrackState } from '../types';
import type { PlaybackClock } from './BouncingBall';

export interface StageCanvasHandle {
  capturePoster: (track: TrackState) => void;
  triggerShockwave: (nx?: number, ny?: number) => void;
}

interface StageCanvasProps {
  biome: ResolvedBiome;
  track: TrackState;
  clockRef: React.RefObject<PlaybackClock>;
  getAudioMetrics: (timeSec: number, isPlaying: boolean) => AudioMetrics;
  onMetricsFrame?: (metrics: AudioMetrics) => void;
  occluded?: boolean;
}

const FULLSCREEN_VERTEX = `
  attribute vec2 aPos;
  varying vec2 vUv;
  void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

// Shared 8-bit pixel grid, 4x4 Bayer ordered dithering, and fast hash helpers
const GLSL_8BIT = `
  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float bayer4x4(vec2 px) {
    vec2 m = mod(floor(px), 4.0);
    int x = int(m.x);
    int y = int(m.y);
    int idx = x + y * 4;
    if (idx == 0) return 0.0 / 16.0;
    if (idx == 1) return 8.0 / 16.0;
    if (idx == 2) return 2.0 / 16.0;
    if (idx == 3) return 10.0 / 16.0;
    if (idx == 4) return 12.0 / 16.0;
    if (idx == 5) return 4.0 / 16.0;
    if (idx == 6) return 14.0 / 16.0;
    if (idx == 7) return 6.0 / 16.0;
    if (idx == 8) return 3.0 / 16.0;
    if (idx == 9) return 11.0 / 16.0;
    if (idx == 10) return 1.0 / 16.0;
    if (idx == 11) return 9.0 / 16.0;
    if (idx == 12) return 15.0 / 16.0;
    if (idx == 13) return 7.0 / 16.0;
    if (idx == 14) return 13.0 / 16.0;
    return 5.0 / 16.0;
  }

  float ditherStep(float val, vec2 px, float levels) {
    float scaled = clamp(val, 0.0, 0.999) * levels;
    float base = floor(scaled);
    float frac = fract(scaled);
    return (base + step(bayer4x4(px), frac)) / levels;
  }

  vec2 pixelateCoord(vec2 uv, vec2 res, float pixelSize, out vec2 px) {
    vec2 grid = floor(res / pixelSize);
    px = floor(uv * grid);
    return (px + 0.5) / grid;
  }
`;

// 8-BIT WORLD 1: Evolving Sunset Ocean (rising/setting sun, stars, comets, wave swells)
const PIXEL_HORIZON_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uAccent;
  uniform vec3 uBg;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uBeat;
  uniform float uProgress;
  uniform sampler2D uSpectrum;

  ${GLSL_8BIT}

  void main() {
    vec2 px;
    vec2 uv = pixelateCoord(vUv, uResolution, 5.0, px);
    vec2 grid = floor(uResolution / 5.0);

    float horizon = 0.43 + sin(uTime * 0.15) * 0.02;
    vec3 col = uBg * 0.35;

    if (uv.y >= horizon) {
      float skyT = clamp(1.0 - (uv.y - horizon) / (1.0 - horizon), 0.0, 1.0);
      float band = ditherStep(skyT, px, 5.0);
      col = mix(uBg * 0.4, mix(uSecondary, uPrimary, band), band);

      // Gentle pixel stars in upper sky (smooth twinkle without harsh treble strobing)
      float starH = hash12(px);
      if (uv.y > horizon + 0.18 && starH > 0.992) {
        float tw = 0.5 + 0.5 * sin(uTime * 1.4 + starH * 40.0);
        col = mix(col, uAccent, tw * 0.75);
      }

      // Occasional shooting pixel comet
      float cometCycle = fract(uTime * 0.22);
      if (cometCycle < 0.35) {
        float cx = cometCycle * 2.8;
        float cy = 0.86 - cometCycle * 0.35;
        vec2 cp = vec2(cx, cy);
        float dComet = length(uv - cp);
        if (dComet < 0.045 && uv.x < cp.x && abs((uv.y - cp.y) + (uv.x - cp.x) * 0.12) < 0.006) {
          col = dComet < 0.012 ? vec3(1.0) : uAccent;
        }
      }

      // Smoothly evolving sun height with subtle warm glow
      float sunElevation = 0.14 + 0.07 * sin(uProgress * 3.14159 + uTime * 0.08);
      vec2 sunCenter = vec2(grid.x * 0.5, grid.y * (horizon + sunElevation));
      float d = length(px - sunCenter);
      float r = grid.y * 0.205;
      if (d < r) {
        float relY = (px.y - (sunCenter.y - r)) / (2.0 * r);
        float cut = mod(px.y - uTime * 1.5, 4.0);
        if (relY > 0.42 || cut > 1.2) {
          vec3 sunCol = mix(uSecondary, uAccent, clamp(relY * 1.35 + uBeat * 0.14, 0.0, 1.0));
          col = mix(sunCol, vec3(1.0), uBeat * 0.08);
        }
      }

      // Live mirrored 8-bit FFT skyline riding along the horizon line
      float specFreq = abs(uv.x - 0.5) * 2.0;
      float specVal = texture2D(uSpectrum, vec2(clamp(specFreq, 0.0, 1.0), 0.5)).r;
      float skylineH = specVal * 0.14;
      if (uv.y < horizon + skylineH) {
        float barFill = (uv.y - horizon) / max(0.001, skylineH);
        vec3 eqCol = mix(uBg * 0.22, mix(uPrimary, uAccent, barFill * 0.85), ditherStep(barFill, px, 4.0));
        col = mix(col, eqCol, 0.82);
        if (abs((uv.y - horizon) - skylineH) < 0.008 && specVal > 0.08) {
          col = mix(col, uAccent, 0.9);
        }
      }

      // Distant drifting pixel islands on the horizon line
      float islandX = px.x + uTime * 2.5;
      float islandH = hash11(floor(islandX / 24.0) * 17.3);
      if (islandH > 0.65 && uv.y < horizon + 0.04 * (islandH - 0.65) * 3.0) {
        col = uBg * 0.25;
      }
    } else {
      // Perspective pixel ocean with smooth wave motion (stable frequency near horizon)
      float depth = max(0.02, horizon - uv.y);
      float z = 1.0 / depth;
      float x = (uv.x - 0.5) * z * 1.6;
      float wave = sin(x * 2.2 + uTime * 2.2) * cos(z * 1.4 - uTime * 3.2);
      float shimmer = smoothstep(0.24, 0.88, wave + uBass * 0.26);
      float waterBand = ditherStep(shimmer * 0.75 + (1.0 - depth * 2.0) * 0.25, px, 4.0);

      col = mix(uBg * 0.28, uPrimary, waterBand);

      float centerGlow = exp(-abs(uv.x - 0.5) * (8.5 - uBeat * 1.6));
      if (centerGlow * (0.6 + wave * 0.4) > 0.46) {
        col = mix(col, uAccent, 0.85);
      }
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

// 8-BIT WORLD 2: Morphing SNES Boss-Fight Bayer Plasma
const PIXEL_PLASMA_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uAccent;
  uniform vec3 uBg;
  uniform float uBass;
  uniform float uMid;
  uniform float uBeat;
  uniform float uProgress;
  uniform sampler2D uSpectrum;

  ${GLSL_8BIT}

  void main() {
    vec2 px;
    vec2 uv = pixelateCoord(vUv, uResolution, 5.0, px);
    vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
    vec2 p = (uv - 0.5) * aspect * 4.5;

    float t = uTime * 1.05;
    // Morphing between wide organic ribbons and concentric interference rings
    float morph = 0.5 + 0.5 * sin(uTime * 0.28 + uProgress * 6.283);

    float ribbon = sin(p.x + t) + sin(p.y * 1.2 - t * 0.8) + sin((p.x + p.y) * 0.8 + t * 1.2);
    float rings = sin(length(p) * (2.6 + uBass * 0.8) - t * 2.1) * 2.2
                + cos(atan(p.y, p.x) * 4.0 + t * 0.9);

    float v = mix(ribbon, rings, morph) + sin(length(p) * 2.0 - t * 1.6 - uBeat * 0.9);
    v = v * 0.22 + 0.5 + uMid * 0.12;

    float q = ditherStep(v, px, 5.0);

    vec3 col = uBg * 0.35;
    if (q > 0.78) {
      col = uAccent;
    } else if (q > 0.56) {
      col = uPrimary;
    } else if (q > 0.34) {
      col = uSecondary;
    } else if (q > 0.16) {
      col = mix(uBg, uSecondary, 0.45);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

// 8-BIT WORLD 3: Shape-Shifting Demoscene Warp Tunnel (Circle -> Octagon -> Square)
const PIXEL_TUNNEL_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uAccent;
  uniform vec3 uBg;
  uniform float uBass;
  uniform float uMid;
  uniform float uBeat;
  uniform float uProgress;
  uniform sampler2D uSpectrum;

  ${GLSL_8BIT}

  void main() {
    vec2 px;
    vec2 uv = pixelateCoord(vUv, uResolution, 5.0, px);
    vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);

    // Lissajous drifting tunnel center
    vec2 center = vec2(sin(uTime * 0.5) * 0.11, cos(uTime * 0.38) * 0.08);
    vec2 p = (uv - 0.5 - center) * aspect;

    // Smoothly morph tunnel cross-section between circle, octagon, and square corridor
    float shapeMorph = 0.5 + 0.5 * sin(uTime * 0.25 + uProgress * 4.0);
    float rCircle = length(p);
    float rSquare = max(abs(p.x), abs(p.y));
    float r = max(0.035, mix(rCircle, rSquare, shapeMorph * 0.85));

    float angle = atan(p.y, p.x);
    // Use monotonic flow-time directly (never multiply uTime by live audio!)
    float depth = 0.55 / r + uTime * 1.55;
    float twistDir = sin(uTime * 0.16);
    float twist = angle / 3.14159 * 4.0 + sin(depth * 0.35) * (0.85 + uMid * 0.25) * twistDir;

    float rings = sin(depth * 3.2) * cos(twist * 3.14159);
    float pulse = exp(-abs(fract(depth * 0.25) - 0.5) * 8.0) * (0.38 + uBeat * 0.35);
    float val = rings * 0.38 + 0.45 + pulse;

    float q = ditherStep(val, px, 5.0);
    float fog = smoothstep(0.03, 0.24, r);

    vec3 col = uBg * 0.3;
    if (q > 0.78) {
      col = mix(uAccent, vec3(1.0), uBeat * 0.14);
    } else if (q > 0.54) {
      col = mix(uPrimary, uAccent, uBeat * 0.14);
    } else if (q > 0.3) {
      col = uSecondary;
    }

    col = mix(uBg * 0.18, col, fog);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// 8-BIT WORLD 4: Morphing EarthBound Pixel Kaleidoscope (4 -> 6 -> 8 -> 12 folds)
const PIXEL_KALEIDO_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uAccent;
  uniform vec3 uBg;
  uniform float uBass;
  uniform float uMid;
  uniform float uBeat;
  uniform float uProgress;
  uniform sampler2D uSpectrum;

  ${GLSL_8BIT}

  void main() {
    vec2 px;
    vec2 uv = pixelateCoord(vUv, uResolution, 5.0, px);
    vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
    vec2 p = (uv - 0.5) * aspect * 3.2;

    // Smooth continuous 8-fold kaleidoscopic mirror symmetry (no discrete floor() snaps)
    float angle = atan(p.y, p.x) + uTime * 0.18;
    float r = length(p);
    float sector = 3.14159 / 4.0;
    angle = mod(angle, sector * 2.0);
    angle = abs(angle - sector);
    vec2 kp = vec2(cos(angle), sin(angle)) * r;

    float t = uTime * 0.85;
    float morph = 0.5 + 0.5 * sin(uTime * 0.22 + uProgress * 3.14159);
    float w1 = sin(kp.x * 2.4 + t) * cos(kp.y * 2.4 - t * 0.7);
    float w2 = sin(length(kp - vec2(1.0 + morph * 0.35, 0.4)) * 3.2 - t * 1.35 - uBeat * 0.4);
    float w3 = cos((kp.x - kp.y) * (1.8 + morph * 0.6) + t * 0.75 + uMid * 0.45);

    float combined = (w1 + w2 + w3) * 0.22 + 0.5;
    float q = ditherStep(combined, px, 5.0);

    vec3 col = uBg * 0.32;
    if (q > 0.78) {
      col = uAccent;
    } else if (q > 0.56) {
      col = uPrimary;
    } else if (q > 0.34) {
      col = uSecondary;
    } else if (q > 0.16) {
      col = mix(uBg, uSecondary, 0.45);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

// 8-BIT WORLD 5: MilkDrop-Inspired 8-Bit Feedback Echo Trails
const PIXEL_ECHO_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uFeedbackTex;
  uniform sampler2D uSpectrum;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uAccent;
  uniform vec3 uBg;
  uniform float uBass;
  uniform float uMid;
  uniform float uBeat;

  ${GLSL_8BIT}

  void main() {
    vec2 px;
    vec2 uv = pixelateCoord(vUv, uResolution, 5.0, px);
    vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);

    // Zoom + gentle rotation feedback UV (MilkDrop echo trail)
    vec2 centered = vUv - 0.5;
    float rot = 0.015 * sin(uTime * 0.45);
    float c = cos(rot);
    float s = sin(rot);
    vec2 rotUv = mat2(c, -s, s, c) * centered;
    float zoom = 0.974 - uBass * 0.012;
    vec2 fbUv = rotUv * zoom + 0.5;

    vec3 prev = texture2D(uFeedbackTex, clamp(fbUv, 0.0, 1.0)).rgb;
    vec3 col = mix(uBg * 0.22, prev, 0.91);

    // Crisp 8-bit radial FFT orbital emitter & pulsing spectrum ring
    vec2 p = (uv - 0.5) * aspect;
    float r = length(p);
    float angNorm = abs(atan(p.y, p.x)) / 3.14159265;
    float radialSpec = texture2D(uSpectrum, vec2(angNorm, 0.5)).r;
    float ringRadius = 0.14 + 0.06 * sin(uTime * 1.1) + uBass * 0.06 + radialSpec * 0.11;
    float ringDist = abs(r - ringRadius);
    if (ringDist < 0.016) {
      col = mix(uPrimary, uAccent, clamp(radialSpec * 0.85 + uBeat * 0.35, 0.0, 1.0));
    }

    // Two orbiting pixel sparks leaving trails
    vec2 orb1 = vec2(cos(uTime * 1.45) * 0.28, sin(uTime * 2.1) * 0.2);
    vec2 orb2 = vec2(sin(uTime * 1.25) * 0.3, cos(uTime * 1.8) * 0.22);
    if (length(p - orb1) < 0.024 + uMid * 0.014) {
      col = uAccent;
    }
    if (length(p - orb2) < 0.022 + uBass * 0.016) {
      col = uSecondary;
    }

    // Subtle Bayer dither quantization so trails stay authentically 8-bit
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    if (luma < 0.08 && bayer4x4(px) > luma * 12.0) {
      col = uBg * 0.22;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

// 8-BIT WORLD 6: Retro CRT Oscilloscope & 64-Band Synthwave Spectrum Grid (Scope)
const PIXEL_SCOPE_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uAccent;
  uniform vec3 uBg;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;
  uniform float uBeat;
  uniform sampler2D uSpectrum;

  ${GLSL_8BIT}

  void main() {
    vec2 px;
    vec2 uv = pixelateCoord(vUv, uResolution, 5.0, px);
    float horizon = 0.38;

    // Deep CRT phosphor backdrop with subtle vertical gradient
    vec3 col = mix(uBg * 0.24, uBg * 0.52, clamp(1.0 - abs(uv.y - horizon) * 1.6, 0.0, 1.0));

    // Perspective synthwave grid below horizon
    if (uv.y < horizon) {
      float depth = max(0.018, horizon - uv.y);
      float z = 0.22 / depth;
      float gx = (uv.x - 0.5) * z * 4.5;
      float gz = z * 3.0 - uTime * (1.8 + uBass * 0.9);
      float lineX = step(0.92, fract(gx)) + step(fract(gx), 0.08);
      float lineZ = step(0.9, fract(gz));
      float gridMask = clamp(lineX + lineZ, 0.0, 1.0) * smoothstep(0.0, 0.24, depth);
      col = mix(col, mix(uSecondary, uPrimary, 0.55), gridMask * 0.42);
    }

    // 32-band mirrored 8-bit FFT spectrum bars rising from horizon
    float numCols = 32.0;
    float colIdx = floor(uv.x * numCols);
    float colFrac = fract(uv.x * numCols);
    float mirrorFreq = abs((colIdx + 0.5) / numCols - 0.5) * 2.0;
    float specAmp = texture2D(uSpectrum, vec2(clamp(mirrorFreq, 0.0, 1.0), 0.5)).r;
    float barHeight = specAmp * 0.44;

    if (colFrac > 0.14 && colFrac < 0.86 && uv.y >= horizon && uv.y <= horizon + barHeight) {
      float relH = (uv.y - horizon) / max(0.001, barHeight);
      // Segmented LED step look
      float seg = step(0.18, fract((uv.y - horizon) * 42.0));
      vec3 barCol = mix(uPrimary, mix(uSecondary, uAccent, relH), relH);
      col = mix(col, barCol, seg * 0.92);
    }
    // Bright peak cap floating on top of each bar
    if (colFrac > 0.14 && colFrac < 0.86 && specAmp > 0.05) {
      float capDist = abs(uv.y - (horizon + barHeight + 0.012));
      if (capDist < 0.008) {
        col = mix(uAccent, vec3(1.0), 0.35 + uBeat * 0.35);
      }
    }

    // Subtle mirrored reflection of spectrum bars on the CRT grid floor
    if (colFrac > 0.14 && colFrac < 0.86 && uv.y < horizon && uv.y >= horizon - barHeight * 0.42) {
      float refFade = 1.0 - (horizon - uv.y) / max(0.001, barHeight * 0.42);
      float dither = ditherStep(refFade * 0.55, px, 3.0);
      col = mix(col, uPrimary, dither * 0.36);
    }

    // Dual-trace glowing oscilloscope waveform riding across upper-center
    float s1 = texture2D(uSpectrum, vec2(uv.x, 0.5)).r;
    float s2 = texture2D(uSpectrum, vec2(1.0 - uv.x, 0.5)).r;
    float waveY1 =
      0.66 +
      sin(uv.x * 18.0 + uTime * 4.2) * (0.04 + s1 * 0.11) +
      cos(uv.x * 34.0 - uTime * 6.5) * (0.015 + uTreble * 0.04);
    float waveY2 =
      0.66 +
      cos(uv.x * 14.0 - uTime * 3.4) * (0.03 + s2 * 0.09);

    float dWave1 = abs(uv.y - waveY1);
    float dWave2 = abs(uv.y - waveY2);
    if (dWave2 < 0.012) {
      col = mix(col, uSecondary, 0.7);
    }
    if (dWave1 < 0.014) {
      col = mix(uAccent, vec3(1.0), smoothstep(0.014, 0.0, dWave1) * 0.75);
    } else if (dWave1 < 0.045) {
      float glow = (1.0 - dWave1 / 0.045);
      col += uPrimary * glow * 0.28;
    }

    // Crisp horizon scanline & subtle CRT horizontal lines
    if (abs(uv.y - horizon) < 0.005) {
      col = mix(col, uAccent, 0.65);
    }
    float scanline = mod(px.y, 2.0) < 1.0 ? 0.92 : 1.0;
    col *= scanline;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const BLIT_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  void main() {
    gl_FragColor = texture2D(uTex, vUv);
  }
`;

// EDITORIAL REELS STAGE BACKDROP (Minimal moody glow + subtle film grain for Kinetic Typography)
const KINETIC_TYPE_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uPrimary;
  uniform vec3 uSecondary;
  uniform vec3 uBg;
  uniform float uBass;
  uniform float uBeat;

  ${GLSL_8BIT}

  void main() {
    vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
    vec2 p = (vUv - 0.5) * aspect;

    vec2 c1 = vec2(sin(uTime * 0.22) * 0.32, cos(uTime * 0.17) * 0.22);
    vec2 c2 = vec2(-cos(uTime * 0.19) * 0.35, sin(uTime * 0.24) * 0.25);

    float g1 = exp(-length(p - c1) * (2.4 - uBass * 0.35));
    float g2 = exp(-length(p - c2) * 2.8);

    vec3 col = uBg * 0.42;
    col += uPrimary * g1 * (0.28 + uBeat * 0.14);
    col += uSecondary * g2 * 0.22;

    // Subtle dark vignette + tactile film grain
    float vig = 1.0 - smoothstep(0.35, 1.35, length(p));
    col *= 0.45 + 0.55 * vig;
    col += (hash12(vUv * 900.0 + fract(uTime * 13.7) * 100.0) - 0.5) * 0.038;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// 8-BIT BAYER DIAMOND WIPE + PIXEL SHOCKWAVE COMPOSITOR
const TRANSITION_COMPOSITE_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uPrevTex;
  uniform sampler2D uCurrTex;
  uniform float uTransition;
  uniform float uShockAge;
  uniform vec2 uShockOrigin;
  uniform vec3 uAccent;
  uniform vec2 uResolution;

  ${GLSL_8BIT}

  vec4 sampleBlended(vec2 uv, vec2 px) {
    if (uTransition >= 0.999) {
      return texture2D(uCurrTex, uv);
    }
    vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
    vec2 d = abs((uv - 0.5) * aspect);
    float diamond = (d.x + d.y) * 0.85;
    float threshold = clamp(diamond - (uTransition * 1.65 - 0.32), 0.0, 1.0);
    float mask = step(bayer4x4(px), 1.0 - threshold);
    return mix(texture2D(uPrevTex, uv), texture2D(uCurrTex, uv), mask);
  }

  void main() {
    vec2 px;
    vec2 pUv = pixelateCoord(vUv, uResolution, 5.0, px);

    if (uShockAge >= 0.999) {
      gl_FragColor = sampleBlended(vUv, px);
      return;
    }

    vec2 aspect = vec2(uResolution.x / max(1.0, uResolution.y), 1.0);
    vec2 delta = (pUv - uShockOrigin) * aspect;
    float dist = length(delta);
    float radius = uShockAge * 1.5;
    float band = 1.0 - smoothstep(0.0, 0.095, abs(dist - radius));
    float fade = (1.0 - uShockAge) * (1.0 - uShockAge);

    vec2 dir = dist > 0.0001 ? delta / dist : vec2(0.0);
    vec2 warpedUv = clamp(vUv - (dir / aspect) * band * 0.035 * fade, 0.0, 1.0);

    vec4 col = sampleBlended(warpedUv, px);
    float rimStrength = band * fade * 0.85;
    float rim = rimStrength > 0.02 ? step(bayer4x4(px) + 0.001, rimStrength) : 0.0;
    col.rgb = mix(col.rgb, mix(uAccent, vec3(1.0), 0.35), rim * 0.72);

    gl_FragColor = col;
  }
`;

interface GlTarget {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

interface GlProgram {
  program: WebGLProgram;
  aPos: number;
  u: Record<string, WebGLUniformLocation | null>;
}

const UNIFORM_NAMES = [
  'uTime',
  'uResolution',
  'uPrimary',
  'uSecondary',
  'uAccent',
  'uBg',
  'uBass',
  'uMid',
  'uTreble',
  'uBeat',
  'uProgress',
  'uSpectrum',
  'uFeedbackTex',
  'uTex',
  'uPrevTex',
  'uCurrTex',
  'uTransition',
  'uShockAge',
  'uShockOrigin',
] as const;

function parseHexToRgb(hex: string, out: [number, number, number]): void {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) {
    out[0] = 0.2;
    out[1] = 0.5;
    out[2] = 0.9;
    return;
  }
  out[0] = ((num >> 16) & 255) / 255;
  out[1] = ((num >> 8) & 255) / 255;
  out[2] = (num & 255) / 255;
}

function lerpRgb(
  cur: [number, number, number],
  target: [number, number, number],
  alpha: number
): void {
  cur[0] += (target[0] - cur[0]) * alpha;
  cur[1] += (target[1] - cur[1]) * alpha;
  cur[2] += (target[2] - cur[2]) * alpha;
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL shader creation failed');
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext,
  vertShader: WebGLShader,
  fragSrc: string
): GlProgram {
  const fragShader = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program creation failed');
  gl.attachShader(program, vertShader);
  gl.attachShader(program, fragShader);
  gl.linkProgram(program);
  gl.deleteShader(fragShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'Unknown program link error';
    gl.deleteProgram(program);
    throw new Error(log);
  }
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const name of UNIFORM_NAMES) {
    u[name] = gl.getUniformLocation(program, name);
  }
  return {
    program,
    aPos: gl.getAttribLocation(program, 'aPos'),
    u,
  };
}

function createTarget(gl: WebGLRenderingContext, width: number, height: number): GlTarget {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) throw new Error('WebGL framebuffer creation failed');

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return { fbo, tex, width, height };
}

function resizeTarget(gl: WebGLRenderingContext, target: GlTarget, width: number, height: number): void {
  if (target.width === width && target.height === height) return;
  target.width = width;
  target.height = height;
  gl.bindTexture(gl.TEXTURE_2D, target.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

export const StageCanvas = memo(
  forwardRef<StageCanvasHandle, StageCanvasProps>(function StageCanvas(
    { biome, track, clockRef, getAudioMetrics, onMetricsFrame, occluded = false },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const renderOnceRef = useRef<((forceDraw?: boolean) => void) | null>(null);
    const triggerShockRef = useRef<((nx?: number, ny?: number) => void) | null>(null);
    const biomeRef = useRef<ResolvedBiome>(biome);
    const trackRef = useRef<TrackState>(track);
    const metricsFnRef = useRef(getAudioMetrics);
    const onMetricsFrameRef = useRef(onMetricsFrame);
    const occludedRef = useRef(occluded);

    biomeRef.current = biome;
    trackRef.current = track;
    metricsFnRef.current = getAudioMetrics;
    onMetricsFrameRef.current = onMetricsFrame;
    occludedRef.current = occluded;

    useImperativeHandle(ref, () => ({
      triggerShockwave(nx = 0.5, ny = 0.5) {
        triggerShockRef.current?.(nx, ny);
      },
      capturePoster(currentTrack: TrackState) {
        const glCanvas = canvasRef.current;
        if (!glCanvas) return;

        renderOnceRef.current?.(true);

        const out = document.createElement('canvas');
        out.width = glCanvas.width;
        out.height = glCanvas.height;
        const ctx = out.getContext('2d');
        if (!ctx) return;

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(glCanvas, 0, 0);

        const grad = ctx.createLinearGradient(0, out.height * 0.68, 0, out.height);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.72)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, out.height * 0.68, out.width, out.height * 0.32);

        const pad = Math.round(out.width * 0.045);
        const titleSize = Math.max(24, Math.round(out.width * 0.025));
        const artistSize = Math.max(13, Math.round(out.width * 0.012));

        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        ctx.font = `600 ${titleSize}px "JetBrains Mono", monospace`;
        ctx.fillText(currentTrack.title, pad, out.height - pad - artistSize * 1.8);

        ctx.fillStyle = 'rgba(255,255,255,0.68)';
        ctx.font = `400 ${artistSize}px "JetBrains Mono", monospace`;
        ctx.fillText(
          `${currentTrack.artist.toUpperCase()} — ${currentTrack.album.toUpperCase()}`,
          pad,
          out.height - pad
        );

        const link = document.createElement('a');
        const safeName = currentTrack.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        link.download = `stage-8bit-${safeName || 'poster'}.png`;
        link.href = out.toDataURL('image/png');
        link.click();
      },
    }));

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      container.appendChild(canvas);
      canvasRef.current = canvas;

      const glOpts: WebGLContextAttributes = {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      };
      const gl = (canvas.getContext('webgl2', glOpts) ??
        canvas.getContext('webgl', glOpts)) as WebGLRenderingContext | null;
      if (!gl) return;

      // Single fullscreen triangle (zero diagonal seam, minimal vertex overhead)
      const triBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

      // Compile & link all shader programs up-front so scene switches have 0ms stutter
      const vertShader = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX);
      const programs: Record<Exclude<ResolvedBiome, 'pixel-echo'>, GlProgram> = {
        'pixel-horizon': createProgram(gl, vertShader, PIXEL_HORIZON_FRAGMENT),
        'pixel-plasma': createProgram(gl, vertShader, PIXEL_PLASMA_FRAGMENT),
        'pixel-tunnel': createProgram(gl, vertShader, PIXEL_TUNNEL_FRAGMENT),
        'pixel-kaleido': createProgram(gl, vertShader, PIXEL_KALEIDO_FRAGMENT),
        'pixel-scope': createProgram(gl, vertShader, PIXEL_SCOPE_FRAGMENT),
        'kinetic-type': createProgram(gl, vertShader, KINETIC_TYPE_FRAGMENT),
      };
      const echoProg = createProgram(gl, vertShader, PIXEL_ECHO_FRAGMENT);
      const blitProg = createProgram(gl, vertShader, BLIT_FRAGMENT);
      const compProg = createProgram(gl, vertShader, TRANSITION_COMPOSITE_FRAGMENT);
      gl.deleteShader(vertShader);

      // 64x1 1D FFT spectrum texture (LUMINANCE works identically in WebGL1 & WebGL2)
      const spectrumTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, spectrumTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        64,
        1,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        new Uint8Array(64)
      );
      gl.bindTexture(gl.TEXTURE_2D, null);

      // Native 8-bit render resolution (1/5 linear = 25x fewer fragment shader invocations)
      const PIXEL_SCALE = 5;
      const lowW = Math.max(1, Math.floor(width / PIXEL_SCALE));
      const lowH = Math.max(1, Math.floor(height / PIXEL_SCALE));

      const rtPrev = createTarget(gl, width, height);
      const rtCurr = createTarget(gl, width, height);
      const rtLow = createTarget(gl, lowW, lowH);
      let rtEchoRead = createTarget(gl, lowW, lowH);
      let rtEchoWrite = createTarget(gl, lowW, lowH);

      const colPrimary: [number, number, number] = [0.2, 0.7, 1.0];
      const colSecondary: [number, number, number] = [0.9, 0.4, 0.7];
      const colAccent: [number, number, number] = [1.0, 0.9, 0.3];
      const colBg: [number, number, number] = [0.04, 0.05, 0.09];
      parseHexToRgb(trackRef.current.palette.primary, colPrimary);
      parseHexToRgb(trackRef.current.palette.secondary, colSecondary);
      parseHexToRgb(trackRef.current.palette.accent, colAccent);
      parseHexToRgb(trackRef.current.palette.background, colBg);

      const targetPrimary: [number, number, number] = [...colPrimary];
      const targetSecondary: [number, number, number] = [...colSecondary];
      const targetAccent: [number, number, number] = [...colAccent];
      const targetBg: [number, number, number] = [...colBg];
      let lastPalP = '';
      let lastPalS = '';
      let lastPalA = '';
      let lastPalB = '';

      let currentWidth = width;
      let currentHeight = height;

      const handleResize = () => {
        if (!container) return;
        const w = Math.max(1, container.clientWidth);
        const h = Math.max(1, container.clientHeight);
        if (w === currentWidth && h === currentHeight) return;
        currentWidth = w;
        currentHeight = h;
        canvas.width = w;
        canvas.height = h;
        const lw = Math.max(1, Math.floor(w / PIXEL_SCALE));
        const lh = Math.max(1, Math.floor(h / PIXEL_SCALE));
        resizeTarget(gl, rtPrev, w, h);
        resizeTarget(gl, rtCurr, w, h);
        resizeTarget(gl, rtLow, lw, lh);
        resizeTarget(gl, rtEchoRead, lw, lh);
        resizeTarget(gl, rtEchoWrite, lw, lh);
      };
      window.addEventListener('resize', handleResize);
      const resizeObserver =
        typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
      resizeObserver?.observe(container);

      let rafId = 0;
      let lastPerfMs = performance.now();
      let elapsedSec = 0;
      let flowTime = 0;
      let smoothProgress = 0;
      let prevBiome: ResolvedBiome = biomeRef.current;
      let activeBiome: ResolvedBiome = biomeRef.current;
      let transitionProgress = 1.0;
      let shockAge = 1.0;
      let shockOriginX = 0.5;
      let shockOriginY = 0.5;
      let lastAutoShockTime = -10;

      const launchShockwave = (nx = 0.5, ny = 0.5) => {
        shockOriginX = nx;
        shockOriginY = ny;
        shockAge = 0.0;
      };
      triggerShockRef.current = launchShockwave;

      const handlePointerDown = (e: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = 1.0 - (e.clientY - rect.top) / rect.height;
        launchShockwave(nx, ny);
      };
      container.addEventListener('pointerdown', handlePointerDown);

      const drawFullscreen = (prog: GlProgram, target: GlTarget | null) => {
        if (target) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
          gl.viewport(0, 0, target.width, target.height);
        } else {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, currentWidth, currentHeight);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
        gl.enableVertexAttribArray(prog.aPos);
        gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };

      const bindSharedUniforms = (prog: GlProgram, metrics: AudioMetrics) => {
        const { u } = prog;
        if (u.uTime) gl.uniform1f(u.uTime, flowTime);
        if (u.uResolution) gl.uniform2f(u.uResolution, currentWidth, currentHeight);
        if (u.uPrimary) gl.uniform3f(u.uPrimary, colPrimary[0], colPrimary[1], colPrimary[2]);
        if (u.uSecondary) gl.uniform3f(u.uSecondary, colSecondary[0], colSecondary[1], colSecondary[2]);
        if (u.uAccent) gl.uniform3f(u.uAccent, colAccent[0], colAccent[1], colAccent[2]);
        if (u.uBg) gl.uniform3f(u.uBg, colBg[0], colBg[1], colBg[2]);
        if (u.uBass) gl.uniform1f(u.uBass, metrics.bass);
        if (u.uMid) gl.uniform1f(u.uMid, metrics.mid);
        if (u.uTreble) gl.uniform1f(u.uTreble, metrics.treble);
        if (u.uBeat) gl.uniform1f(u.uBeat, metrics.beat);
        if (u.uProgress) gl.uniform1f(u.uProgress, smoothProgress);
        if (u.uSpectrum) {
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, spectrumTex);
          gl.uniform1i(u.uSpectrum, 2);
        }
      };

      const renderFrame = (forceDraw = false) => {
        const nowMs = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (nowMs - lastPerfMs) * 0.001));
        lastPerfMs = nowMs;
        elapsedSec += dt;

        const activeTrack = trackRef.current;
        const nextBiome = biomeRef.current;

        if (nextBiome !== activeBiome) {
          prevBiome = activeBiome;
          activeBiome = nextBiome;
          transitionProgress = 0.0;
        }

        if (transitionProgress < 1.0) {
          transitionProgress = Math.min(1.0, transitionProgress + dt / 0.55);
        }

        if (shockAge < 1.0) {
          shockAge = Math.min(1.0, shockAge + dt / 0.65);
        }

        const metrics = metricsFnRef.current(elapsedSec, activeTrack.isPlaying);
        onMetricsFrameRef.current?.(metrics);

        if (
          metrics.audioSource !== 'none' &&
          metrics.beat > 0.72 &&
          metrics.bass > 0.45 &&
          elapsedSec - lastAutoShockTime > 1.0
        ) {
          lastAutoShockTime = elapsedSec;
          launchShockwave(0.5, 0.5);
        }

        const speedScale = activeTrack.isPlaying ? 0.6 + metrics.energy * 1.9 : 0.18;
        flowTime += dt * speedScale;

        const pal = activeTrack.palette;
        if (
          pal.primary !== lastPalP ||
          pal.secondary !== lastPalS ||
          pal.accent !== lastPalA ||
          pal.background !== lastPalB
        ) {
          lastPalP = pal.primary;
          lastPalS = pal.secondary;
          lastPalA = pal.accent;
          lastPalB = pal.background;
          parseHexToRgb(pal.primary, targetPrimary);
          parseHexToRgb(pal.secondary, targetSecondary);
          parseHexToRgb(pal.accent, targetAccent);
          parseHexToRgb(pal.background, targetBg);
        }

        const colorLerp = 1 - Math.exp(-5.5 * dt);
        lerpRgb(colPrimary, targetPrimary, colorLerp);
        lerpRgb(colSecondary, targetSecondary, colorLerp);
        lerpRgb(colAccent, targetAccent, colorLerp);
        lerpRgb(colBg, targetBg, colorLerp);

        const clock = clockRef.current;
        const liveProgressMs = clock.isPlaying
          ? clock.progressMs + (nowMs - clock.updatedAt)
          : clock.progressMs;
        const targetProgress = Math.min(
          1,
          Math.max(0, liveProgressMs / Math.max(1, activeTrack.durationMs))
        );
        smoothProgress += (targetProgress - smoothProgress) * (1 - Math.exp(-4.0 * dt));

        const needsComposite = transitionProgress < 0.999 || shockAge < 0.999;

        // Skip GPU fragment shader work completely when opaque Type stage covers the canvas
        if (!forceDraw && occludedRef.current && !needsComposite) {
          return;
        }

        // Upload 64-byte FFT spectrum into 1D GPU texture (TEXTURE2)
        if (spectrumTex && metrics.spectrum.length >= 64) {
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, spectrumTex);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            64,
            1,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            metrics.spectrum
          );
        }

        const stepEcho = () => {
          gl.useProgram(echoProg.program);
          bindSharedUniforms(echoProg, metrics);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, rtEchoRead.tex);
          if (echoProg.u.uFeedbackTex) gl.uniform1i(echoProg.u.uFeedbackTex, 0);
          drawFullscreen(echoProg, rtEchoWrite);
          const tmp = rtEchoRead;
          rtEchoRead = rtEchoWrite;
          rtEchoWrite = tmp;
        };

        const blitTexture = (tex: WebGLTexture, target: GlTarget | null) => {
          gl.useProgram(blitProg.program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          if (blitProg.u.uTex) gl.uniform1i(blitProg.u.uTex, 0);
          drawFullscreen(blitProg, target);
        };

        const renderBiome = (b: ResolvedBiome, target: GlTarget | null) => {
          if (b === 'pixel-echo') {
            blitTexture(rtEchoRead.tex, target);
          } else if (b === 'kinetic-type') {
            const prog = programs[b];
            gl.useProgram(prog.program);
            bindSharedUniforms(prog, metrics);
            drawFullscreen(prog, target);
          } else {
            const prog = programs[b];
            gl.useProgram(prog.program);
            bindSharedUniforms(prog, metrics);
            drawFullscreen(prog, rtLow);
            blitTexture(rtLow.tex, target);
          }
        };

        if (activeBiome === 'pixel-echo' || (transitionProgress < 0.999 && prevBiome === 'pixel-echo')) {
          stepEcho();
        }

        if (needsComposite) {
          if (transitionProgress < 0.999) {
            renderBiome(prevBiome, rtPrev);
          }
          renderBiome(activeBiome, rtCurr);

          gl.useProgram(compProg.program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, rtPrev.tex);
          if (compProg.u.uPrevTex) gl.uniform1i(compProg.u.uPrevTex, 0);

          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, rtCurr.tex);
          if (compProg.u.uCurrTex) gl.uniform1i(compProg.u.uCurrTex, 1);

          if (compProg.u.uTransition) gl.uniform1f(compProg.u.uTransition, transitionProgress);
          if (compProg.u.uShockAge) gl.uniform1f(compProg.u.uShockAge, shockAge);
          if (compProg.u.uShockOrigin) gl.uniform2f(compProg.u.uShockOrigin, shockOriginX, shockOriginY);
          if (compProg.u.uAccent) {
            gl.uniform3f(compProg.u.uAccent, colAccent[0], colAccent[1], colAccent[2]);
          }
          if (compProg.u.uResolution) gl.uniform2f(compProg.u.uResolution, currentWidth, currentHeight);

          drawFullscreen(compProg, null);
        } else {
          renderBiome(activeBiome, null);
        }
      };

      renderOnceRef.current = renderFrame;

      const animate = () => {
        if (document.hidden) {
          rafId = 0;
          return;
        }
        rafId = requestAnimationFrame(animate);
        renderFrame();
      };

      const handleVisibility = () => {
        if (document.hidden) {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
        } else if (!rafId) {
          lastPerfMs = performance.now();
          animate();
        }
      };
      document.addEventListener('visibilitychange', handleVisibility);

      animate();

      return () => {
        cancelAnimationFrame(rafId);
        document.removeEventListener('visibilitychange', handleVisibility);
        resizeObserver?.disconnect();
        window.removeEventListener('resize', handleResize);
        container.removeEventListener('pointerdown', handlePointerDown);
        renderOnceRef.current = null;
        triggerShockRef.current = null;
        canvasRef.current = null;

        const disposeTarget = (t: GlTarget) => {
          gl.deleteTexture(t.tex);
          gl.deleteFramebuffer(t.fbo);
        };
        disposeTarget(rtPrev);
        disposeTarget(rtCurr);
        disposeTarget(rtLow);
        disposeTarget(rtEchoRead);
        disposeTarget(rtEchoWrite);
        if (spectrumTex) gl.deleteTexture(spectrumTex);
        gl.deleteBuffer(triBuf);
        Object.values(programs).forEach((p) => gl.deleteProgram(p.program));
        gl.deleteProgram(echoProg.program);
        gl.deleteProgram(blitProg.program);
        gl.deleteProgram(compProg.program);

        if (canvas.parentNode === container) {
          container.removeChild(canvas);
        }
      };
    }, [clockRef]);

    return <div ref={containerRef} className="stage-canvas" />;
  })
);
