import type { AudioMetrics, AudioSourceType } from '../types';

export class LiveAudioAnalyzer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private prevBins: Uint8Array<ArrayBuffer> | null = null;
  private bassHistory = 0;
  private fluxHistory = 0;
  private runningPeak = 0.45;
  private gain = 1.0;
  private lastSampleTimeSec: number | null = null;
  private lastBeatTimeSec = -10;
  private beatIntervals: number[] = [];
  private spectrumFloat = new Float32Array(64);
  private spectrumBins = new Uint8Array(64);
  private smoothed: AudioMetrics = {
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    beat: 0,
    bpm: 0,
    beatCount: 0,
    audioSource: 'none',
    spectrum: this.spectrumBins,
  };

  setGain(nextGain: number): void {
    this.gain = Math.max(0.5, Math.min(2.5, nextGain));
  }

  private connectStream(stream: MediaStream, sourceType: AudioSourceType, onEnded?: () => void): void {
    this.stop();

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    // 256 samples @ 48kHz = ~5.3ms FFT window; low smoothing keeps transient punch crisp
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.28;

    source.connect(analyser);

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.onended = () => {
        this.stop();
        onEnded?.();
      };
    }

    this.ctx = ctx;
    this.analyser = analyser;
    this.stream = stream;
    this.dataArray = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.prevBins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.fluxHistory = 0;
    this.runningPeak = 0.45;
    this.lastSampleTimeSec = null;
    this.lastBeatTimeSec = -10;
    this.beatIntervals = [];
    this.smoothed.bpm = 0;
    this.smoothed.beatCount = 0;
    this.smoothed.audioSource = sourceType;
  }

  async startMic(onEnded?: () => void): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.connectStream(stream, 'mic', onEnded);
  }

  async startSystemAudio(onEnded?: () => void): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    // Stop the dummy video track immediately; we only need the audio stream
    stream.getVideoTracks().forEach((t) => t.stop());

    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Отметьте «Поделиться аудио» при выборе вкладки');
    }

    this.connectStream(stream, 'system', onEnded);
  }

  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.analyser = null;
    this.dataArray = null;
    this.prevBins = null;
    this.bassHistory = 0;
    this.fluxHistory = 0;
    this.runningPeak = 0.45;
    this.lastSampleTimeSec = null;
    this.lastBeatTimeSec = -10;
    this.beatIntervals = [];
    this.smoothed.bpm = 0;
    this.smoothed.beatCount = 0;
    this.smoothed.audioSource = 'none';
  }

  // Frame-rate-independent asymmetric envelope (instant attack, smooth musical release)
  private follow(current: number, target: number, dt: number, attackRate: number, releaseRate: number): number {
    const rate = target > current ? attackRate : releaseRate;
    const alpha = 1 - Math.exp(-rate * dt);
    return current + (target - current) * alpha;
  }

  sample(timeSec: number, isPlaying: boolean): AudioMetrics {
    const dt =
      this.lastSampleTimeSec === null
        ? 1 / 60
        : Math.min(0.05, Math.max(0.001, timeSec - this.lastSampleTimeSec));
    this.lastSampleTimeSec = timeSec;

    if (this.analyser && this.dataArray && this.prevBins && this.smoothed.audioSource !== 'none') {
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      this.analyser.getByteFrequencyData(this.dataArray);
      const bins = this.dataArray;
      const prev = this.prevBins;
      const len = bins.length;

      // Positive spectral flux (low-band weighted for kick/snare transients)
      let fluxSum = 0;
      const fluxEnd = Math.min(len, 48);
      for (let i = 0; i < fluxEnd; i++) {
        const diff = bins[i] - prev[i];
        if (diff > 0) {
          fluxSum += i < 12 ? diff * 1.6 : diff;
        }
        prev[i] = bins[i];
      }
      const normFlux = fluxSum / (Math.max(1, fluxEnd) * 255);

      let bassSum = 0;
      const bassEnd = Math.min(len, 8);
      for (let i = 0; i < bassEnd; i++) bassSum += bins[i];
      const baseBass = bassSum / (Math.max(1, bassEnd) * 255);

      let midSum = 0;
      const midEnd = Math.min(len, 36);
      for (let i = 8; i < midEnd; i++) midSum += bins[i];
      const baseMid = midSum / (Math.max(1, midEnd - 8) * 255);

      let trebleSum = 0;
      const trebleEnd = Math.min(len, 96);
      for (let i = 36; i < trebleEnd; i++) trebleSum += bins[i];
      const baseTreble = trebleSum / (Math.max(1, trebleEnd - 36) * 255);

      // Adaptive loudness auto-normalization (responds smoothly to quiet ambient & loud drops)
      const instantPeak = Math.max(baseBass, baseMid * 0.9, baseTreble * 0.8);
      if (instantPeak > this.runningPeak) {
        this.runningPeak += (instantPeak - this.runningPeak) * (1 - Math.exp(-8.0 * dt));
      } else {
        this.runningPeak = Math.max(
          0.18,
          this.runningPeak + (instantPeak - this.runningPeak) * (1 - Math.exp(-0.35 * dt))
        );
      }
      const autoScale = Math.min(2.2, Math.max(0.75, 0.72 / Math.max(0.18, this.runningPeak))) * this.gain;

      const rawBass = Math.min(1, baseBass * autoScale);
      const rawMid = Math.min(1, baseMid * autoScale);
      const rawTreble = Math.min(1, baseTreble * autoScale);
      const rawEnergy = rawBass * 0.5 + rawMid * 0.35 + rawTreble * 0.15;

      // Adaptive Spectral Flux + Bass transient detector
      const bassDelta = rawBass - this.bassHistory;
      const histAlpha = 1 - Math.exp(-7.5 * dt);
      this.bassHistory += (rawBass - this.bassHistory) * histAlpha;

      const fluxAlpha = 1 - Math.exp(-5.0 * dt);
      const fluxThreshold = Math.max(0.035, this.fluxHistory * 1.45);
      this.fluxHistory += (normFlux - this.fluxHistory) * fluxAlpha;

      const fluxImpulse =
        normFlux > fluxThreshold ? Math.min(1, ((normFlux - fluxThreshold) / fluxThreshold) * 0.85) : 0;
      const bassImpulse = bassDelta > 0.03 ? Math.min(1, bassDelta * 6.0) : 0;
      const beatImpulse = Math.max(fluxImpulse, bassImpulse);

      this.smoothed.bass = this.follow(this.smoothed.bass, rawBass, dt, 48, 12);
      this.smoothed.mid = this.follow(this.smoothed.mid, rawMid, dt, 42, 11);
      this.smoothed.treble = this.follow(this.smoothed.treble, rawTreble, dt, 44, 13);
      this.smoothed.energy = this.follow(this.smoothed.energy, rawEnergy, dt, 38, 10);

      const decayedBeat = this.smoothed.beat * Math.exp(-10.5 * dt);
      this.smoothed.beat = beatImpulse > decayedBeat ? beatImpulse : decayedBeat;

      // Pack 64 log-curved FFT bins with asymmetric smoothing into reusable Uint8Array (0 GC)
      const maxBin = Math.min(len - 1, 96);
      const specAttack = 1 - Math.exp(-42 * dt);
      const specRelease = 1 - Math.exp(-11 * dt);
      for (let i = 0; i < 64; i++) {
        const t = i / 63;
        const idx = Math.min(maxBin, Math.floor(Math.pow(t, 1.45) * maxBin));
        const target = Math.min(1, (bins[idx] / 255) * autoScale);
        const cur = this.spectrumFloat[i];
        const next = cur + (target - cur) * (target > cur ? specAttack : specRelease);
        this.spectrumFloat[i] = next;
        this.spectrumBins[i] = Math.min(255, Math.max(0, Math.round(next * 255)));
      }

      // Auto-BPM tracker from beat onset intervals (median-filtered, 70–180 BPM range)
      if (beatImpulse > 0.52 && timeSec - this.lastBeatTimeSec >= 0.28) {
        const interval = timeSec - this.lastBeatTimeSec;
        this.lastBeatTimeSec = timeSec;
        this.smoothed.beatCount += 1;

        if (interval >= 0.28 && interval <= 1.2) {
          this.beatIntervals.push(interval);
          if (this.beatIntervals.length > 10) {
            this.beatIntervals.shift();
          }
          if (this.beatIntervals.length >= 4) {
            const sorted = [...this.beatIntervals].sort((a, b) => a - b);
            const medianInterval = sorted[sorted.length >> 1];
            let estBpm = 60 / medianInterval;
            while (estBpm < 72) estBpm *= 2;
            while (estBpm > 176) estBpm /= 2;
            this.smoothed.bpm = Math.round(estBpm);
          }
        }
      }

      return this.smoothed;
    }

    const active = isPlaying ? 1 : 0.2;
    const drift1 = (0.14 + 0.08 * Math.sin(timeSec * 0.45)) * active;
    const drift2 = (0.12 + 0.07 * Math.cos(timeSec * 0.32)) * active;
    const drift3 = (0.1 + 0.06 * Math.sin(timeSec * 0.6)) * active;

    const idleAlpha = 1 - Math.exp(-5.0 * dt);
    this.smoothed.bass += (drift1 - this.smoothed.bass) * idleAlpha;
    this.smoothed.mid += (drift2 - this.smoothed.mid) * idleAlpha;
    this.smoothed.treble += (drift3 - this.smoothed.treble) * idleAlpha;
    this.smoothed.beat *= Math.exp(-6.5 * dt);
    this.smoothed.energy = (this.smoothed.bass + this.smoothed.mid + this.smoothed.treble) / 3;

    // Musical procedural spectrum fallback when live mic/tab audio is not connected
    const specIdleAlpha = 1 - Math.exp(-8.0 * dt);
    for (let i = 0; i < 64; i++) {
      const f = i / 63;
      const bassEnv = Math.exp(-f * 4.2) * (0.42 + 0.28 * Math.sin(timeSec * 3.1 + f * 3.0));
      const midEnv =
        Math.exp(-Math.pow((f - 0.36) * 4.5, 2)) * (0.34 + 0.24 * Math.sin(timeSec * 2.3 - f * 9.0));
      const highEnv =
        Math.exp(-Math.pow((f - 0.72) * 5.0, 2)) * (0.2 + 0.16 * Math.cos(timeSec * 4.1 + f * 14.0));
      const ripple = 0.08 * Math.sin(timeSec * 5.2 + i * 0.48) * (1 - f * 0.5);
      const target = Math.min(1, Math.max(0.02, (bassEnv + midEnv + highEnv + ripple) * active));
      const next = this.spectrumFloat[i] + (target - this.spectrumFloat[i]) * specIdleAlpha;
      this.spectrumFloat[i] = next;
      this.spectrumBins[i] = Math.min(255, Math.max(0, Math.round(next * 255)));
    }

    return this.smoothed;
  }
}
