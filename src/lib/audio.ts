import type { AudioMetrics, AudioSourceType } from '../types';

export class LiveAudioAnalyzer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private bassHistory = 0;
  private energyHistory = 0;
  private gain = 1.0;
  private lastSampleTimeSec: number | null = null;
  private smoothed: AudioMetrics = {
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    beat: 0,
    audioSource: 'none',
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
    this.lastSampleTimeSec = null;
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
    this.bassHistory = 0;
    this.energyHistory = 0;
    this.lastSampleTimeSec = null;
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

    if (this.analyser && this.dataArray && this.smoothed.audioSource !== 'none') {
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      this.analyser.getByteFrequencyData(this.dataArray);
      const bins = this.dataArray;
      const len = bins.length;

      let bassSum = 0;
      const bassEnd = Math.min(len, 8);
      for (let i = 0; i < bassEnd; i++) bassSum += bins[i];
      const rawBass = Math.min(1, (bassSum / (Math.max(1, bassEnd) * 255)) * this.gain);

      let midSum = 0;
      const midEnd = Math.min(len, 36);
      for (let i = 8; i < midEnd; i++) midSum += bins[i];
      const rawMid = Math.min(1, (midSum / (Math.max(1, midEnd - 8) * 255)) * this.gain);

      let trebleSum = 0;
      const trebleEnd = Math.min(len, 96);
      for (let i = 36; i < trebleEnd; i++) trebleSum += bins[i];
      const rawTreble = Math.min(1, (trebleSum / (Math.max(1, trebleEnd - 36) * 255)) * this.gain);

      const rawEnergy = rawBass * 0.5 + rawMid * 0.35 + rawTreble * 0.15;

      // Zero-lag transient detector: snap beat immediately on kick/drop, decay smoothly
      const bassDelta = rawBass - this.bassHistory;
      const energyDelta = rawEnergy - this.energyHistory;
      const histAlpha = 1 - Math.exp(-7.5 * dt);
      this.bassHistory += (rawBass - this.bassHistory) * histAlpha;
      this.energyHistory += (rawEnergy - this.energyHistory) * histAlpha;

      const transient = Math.max(bassDelta * 6.2, energyDelta * 4.8);
      const beatImpulse = transient > 0.16 ? Math.min(1, transient) : 0;

      this.smoothed.bass = this.follow(this.smoothed.bass, rawBass, dt, 48, 12);
      this.smoothed.mid = this.follow(this.smoothed.mid, rawMid, dt, 42, 11);
      this.smoothed.treble = this.follow(this.smoothed.treble, rawTreble, dt, 44, 13);
      this.smoothed.energy = this.follow(this.smoothed.energy, rawEnergy, dt, 38, 10);

      const decayedBeat = this.smoothed.beat * Math.exp(-10.5 * dt);
      this.smoothed.beat = beatImpulse > decayedBeat ? beatImpulse : decayedBeat;

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

    return this.smoothed;
  }
}
