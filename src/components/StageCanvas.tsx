import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
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
}

const FULLSCREEN_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
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

    // Crisp 8-bit orbital emitter & pulsing diamond ring
    vec2 p = (uv - 0.5) * aspect;
    float r = length(p);
    float ringRadius = 0.16 + 0.08 * sin(uTime * 1.1) + uBass * 0.09;
    float ringDist = abs(r - ringRadius);
    if (ringDist < 0.016) {
      col = mix(uPrimary, uAccent, uBeat * 0.5);
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

export const StageCanvas = memo(
  forwardRef<StageCanvasHandle, StageCanvasProps>(function StageCanvas(
    { biome, track, clockRef, getAudioMetrics, onMetricsFrame },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const renderOnceRef = useRef<(() => void) | null>(null);
    const triggerShockRef = useRef<((nx?: number, ny?: number) => void) | null>(null);
    const biomeRef = useRef<ResolvedBiome>(biome);
    const trackRef = useRef<TrackState>(track);
    const metricsFnRef = useRef(getAudioMetrics);
    const onMetricsFrameRef = useRef(onMetricsFrame);

    biomeRef.current = biome;
    trackRef.current = track;
    metricsFnRef.current = getAudioMetrics;
    onMetricsFrameRef.current = onMetricsFrame;

  useImperativeHandle(ref, () => ({
    triggerShockwave(nx = 0.5, ny = 0.5) {
      triggerShockRef.current?.(nx, ny);
    },
    capturePoster(currentTrack: TrackState) {
      const glCanvas = rendererRef.current?.domElement;
      if (!glCanvas) return;

      renderOnceRef.current?.();

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

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Two crisp NearestFilter render targets for 8-bit transitions
    const rtParams: THREE.RenderTargetOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    const rtPrev = new THREE.WebGLRenderTarget(width, height, rtParams);
    const rtCurr = new THREE.WebGLRenderTarget(width, height, rtParams);
    let rtEchoRead = new THREE.WebGLRenderTarget(width, height, rtParams);
    let rtEchoWrite = new THREE.WebGLRenderTarget(width, height, rtParams);

    const colPrimary = new THREE.Color(trackRef.current.palette.primary);
    const colSecondary = new THREE.Color(trackRef.current.palette.secondary);
    const colAccent = new THREE.Color(trackRef.current.palette.accent);
    const colBg = new THREE.Color(trackRef.current.palette.background);

    // Pre-allocated target colors (zero GC allocations per frame)
    const targetPrimary = colPrimary.clone();
    const targetSecondary = colSecondary.clone();
    const targetAccent = colAccent.clone();
    const targetBg = colBg.clone();
    let cachedPaletteKey = '';

    const sharedUniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(width, height) },
      uPrimary: { value: colPrimary },
      uSecondary: { value: colSecondary },
      uAccent: { value: colAccent },
      uBg: { value: colBg },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uBeat: { value: 0 },
      uProgress: { value: 0 },
    };

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quadGeo = new THREE.PlaneGeometry(2, 2);

    const echoUniforms = {
      ...sharedUniforms,
      uFeedbackTex: { value: rtEchoRead.texture },
    };
    const echoMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: PIXEL_ECHO_FRAGMENT,
      uniforms: echoUniforms,
    });
    const blitUniforms = {
      uTex: { value: rtEchoRead.texture },
    };
    const blitMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BLIT_FRAGMENT,
      uniforms: blitUniforms,
    });

    const materials: Record<Exclude<ResolvedBiome, 'pixel-echo'>, THREE.ShaderMaterial> = {
      'pixel-horizon': new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: PIXEL_HORIZON_FRAGMENT,
        uniforms: sharedUniforms,
      }),
      'pixel-plasma': new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: PIXEL_PLASMA_FRAGMENT,
        uniforms: sharedUniforms,
      }),
      'pixel-tunnel': new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: PIXEL_TUNNEL_FRAGMENT,
        uniforms: sharedUniforms,
      }),
      'pixel-kaleido': new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: PIXEL_KALEIDO_FRAGMENT,
        uniforms: sharedUniforms,
      }),
      'kinetic-type': new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: KINETIC_TYPE_FRAGMENT,
        uniforms: sharedUniforms,
      }),
    };

    const quadMesh = new THREE.Mesh(quadGeo, materials['pixel-horizon']);
    scene.add(quadMesh);

    const compScene = new THREE.Scene();
    const compUniforms = {
      uPrevTex: { value: rtPrev.texture },
      uCurrTex: { value: rtCurr.texture },
      uTransition: { value: 1.0 },
      uShockAge: { value: 1.0 },
      uShockOrigin: { value: new THREE.Vector2(0.5, 0.5) },
      uAccent: { value: colAccent },
      uResolution: { value: new THREE.Vector2(width, height) },
    };
    const compMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: TRANSITION_COMPOSITE_FRAGMENT,
      uniforms: compUniforms,
    });
    const compMesh = new THREE.Mesh(quadGeo, compMat);
    compScene.add(compMesh);

    // Pre-compile all shader programs up-front so biome switches (1-6 / Auto VJ) have 0ms stutter
    const allMats: THREE.ShaderMaterial[] = [
      ...Object.values(materials),
      echoMat,
      blitMat,
    ];
    for (const mat of allMats) {
      quadMesh.material = mat;
      renderer.compile(scene, camera);
    }
    renderer.compile(compScene, camera);
    quadMesh.material = materials['pixel-horizon'];

    let currentWidth = width;
    let currentHeight = height;

    const handleResize = () => {
      if (!container) return;
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      if (w === currentWidth && h === currentHeight) return;
      currentWidth = w;
      currentHeight = h;
      renderer.setSize(w, h);
      rtPrev.setSize(w, h);
      rtCurr.setSize(w, h);
      rtEchoRead.setSize(w, h);
      rtEchoWrite.setSize(w, h);
      sharedUniforms.uResolution.value.set(w, h);
      compUniforms.uResolution.value.set(w, h);
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
    let lastAutoShockTime = -10;

    const launchShockwave = (nx = 0.5, ny = 0.5) => {
      compUniforms.uShockOrigin.value.set(nx, ny);
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

    const renderFrame = () => {
      const nowMs = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (nowMs - lastPerfMs) * 0.001));
      lastPerfMs = nowMs;
      elapsedSec += dt;

      const activeTrack = trackRef.current;
      const nextBiome = biomeRef.current;

      // Trigger 8-bit Bayer diamond wipe only when the visual biome actually changes
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

      // Auto-trigger pixel shockwave on strong live bass drops (min 1.0s cooldown)
      if (
        metrics.audioSource !== 'none' &&
        metrics.beat > 0.72 &&
        metrics.bass > 0.45 &&
        elapsedSec - lastAutoShockTime > 1.0
      ) {
        lastAutoShockTime = elapsedSec;
        launchShockwave(0.5, 0.5);
      }

      // Accumulate energy-driven flow time so worlds slow down in quiet parts and surge on drops
      const speedScale = activeTrack.isPlaying ? 0.6 + metrics.energy * 1.9 : 0.18;
      flowTime += dt * speedScale;

      const pal = activeTrack.palette;
      const palKey = `${pal.primary}${pal.secondary}${pal.accent}${pal.background}`;
      if (palKey !== cachedPaletteKey) {
        cachedPaletteKey = palKey;
        targetPrimary.set(pal.primary);
        targetSecondary.set(pal.secondary);
        targetAccent.set(pal.accent);
        targetBg.set(pal.background);
      }

      // Frame-rate-independent palette & progress smoothing (consistent across 60Hz/120Hz/144Hz)
      const colorLerp = 1 - Math.exp(-5.5 * dt);
      colPrimary.lerp(targetPrimary, colorLerp);
      colSecondary.lerp(targetSecondary, colorLerp);
      colAccent.lerp(targetAccent, colorLerp);
      colBg.lerp(targetBg, colorLerp);

      const clock = clockRef.current;
      const liveProgressMs = clock.isPlaying
        ? clock.progressMs + (nowMs - clock.updatedAt)
        : clock.progressMs;
      const targetProgress = Math.min(1, Math.max(0, liveProgressMs / Math.max(1, activeTrack.durationMs)));
      smoothProgress += (targetProgress - smoothProgress) * (1 - Math.exp(-4.0 * dt));

      sharedUniforms.uTime.value = flowTime;
      sharedUniforms.uBass.value = metrics.bass;
      sharedUniforms.uMid.value = metrics.mid;
      sharedUniforms.uTreble.value = metrics.treble;
      sharedUniforms.uBeat.value = metrics.beat;
      sharedUniforms.uProgress.value = smoothProgress;

      const stepEcho = () => {
        echoUniforms.uFeedbackTex.value = rtEchoRead.texture;
        quadMesh.material = echoMat;
        renderer.setRenderTarget(rtEchoWrite);
        renderer.render(scene, camera);
        const tmp = rtEchoRead;
        rtEchoRead = rtEchoWrite;
        rtEchoWrite = tmp;
      };

      const renderBiome = (b: ResolvedBiome, target: THREE.WebGLRenderTarget | null) => {
        if (b === 'pixel-echo') {
          blitUniforms.uTex.value = rtEchoRead.texture;
          quadMesh.material = blitMat;
        } else {
          quadMesh.material = materials[b];
        }
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
      };

      // Update echo ping-pong buffer once per frame whenever echo is visible
      if (activeBiome === 'pixel-echo' || (transitionProgress < 0.999 && prevBiome === 'pixel-echo')) {
        stepEcho();
      }

      const needsComposite = transitionProgress < 0.999 || shockAge < 0.999;

      if (needsComposite) {
        if (transitionProgress < 0.999) {
          renderBiome(prevBiome, rtPrev);
        }
        renderBiome(activeBiome, rtCurr);

        compUniforms.uTransition.value = transitionProgress;
        compUniforms.uShockAge.value = shockAge;
        renderer.setRenderTarget(null);
        renderer.render(compScene, camera);
      } else {
        // Direct render (zero overhead when idle)
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
      rtPrev.dispose();
      rtCurr.dispose();
      rtEchoRead.dispose();
      rtEchoWrite.dispose();
      quadGeo.dispose();
      echoMat.dispose();
      blitMat.dispose();
      compMat.dispose();
      Object.values(materials).forEach((m) => m.dispose());
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [clockRef]);

  return <div ref={containerRef} className="stage-canvas" />;
  })
);
