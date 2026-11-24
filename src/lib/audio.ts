import type { AudioMetrics, AudioSourceType } from '../types';

export class LiveAudioAnalyzer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private bassHistory = 0;
  private gain = 1.0;
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

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;

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
    this.smoothed.audioSource = 'none';
  }

  sample(timeSec: number, isPlaying: boolean): AudioMetrics {
    if (this.analyser && this.dataArray && this.smoothed.audioSource !== 'none') {
      this.analyser.getByteFrequencyData(this.dataArray);
      const bins = this.dataArray;
      const len = bins.length;

      const avgRange = (start: number, end: number) => {
        let sum = 0;
        const clampedEnd = Math.min(len, end);
        const count = Math.max(1, clampedEnd - start);
        for (let i = start; i < clampedEnd; i++) sum += bins[i];
        return sum / (count * 255);
      };

      const rawBass = Math.min(1, avgRange(0, 8) * this.gain);
      const rawMid = Math.min(1, avgRange(8, 36) * this.gain);
      const rawTreble = Math.min(1, avgRange(36, 96) * this.gain);
      const rawEnergy = rawBass * 0.5 + rawMid * 0.35 + rawTreble * 0.15;

      const delta = rawBass - this.bassHistory;
      this.bassHistory += (rawBass - this.bassHistory) * 0.1;
      const beatImpulse = delta > 0.032 ? Math.min(1, delta * 5.5) : 0;

      this.smoothed.bass += (rawBass - this.smoothed.bass) * 0.28;
      this.smoothed.mid += (rawMid - this.smoothed.mid) * 0.24;
      this.smoothed.treble += (rawTreble - this.smoothed.treble) * 0.24;
      this.smoothed.energy += (rawEnergy - this.smoothed.energy) * 0.24;
      this.smoothed.beat += (Math.max(this.smoothed.beat * 0.88, beatImpulse) - this.smoothed.beat) * 0.38;

      return { ...this.smoothed };
    }

    const active = isPlaying ? 1 : 0.2;
    const drift1 = (0.14 + 0.08 * Math.sin(timeSec * 0.45)) * active;
    const drift2 = (0.12 + 0.07 * Math.cos(timeSec * 0.32)) * active;
    const drift3 = (0.1 + 0.06 * Math.sin(timeSec * 0.6)) * active;

    this.smoothed.bass += (drift1 - this.smoothed.bass) * 0.08;
    this.smoothed.mid += (drift2 - this.smoothed.mid) * 0.08;
    this.smoothed.treble += (drift3 - this.smoothed.treble) * 0.08;
    this.smoothed.beat += (0 - this.smoothed.beat) * 0.1;
    this.smoothed.energy = (this.smoothed.bass + this.smoothed.mid + this.smoothed.treble) / 3;

    return { ...this.smoothed };
  }
}
