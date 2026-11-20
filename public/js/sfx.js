// Swirl: synthesized sounds (WebAudio, no assets), including a continuous pour.

export class Sfx {
  constructor(key = "swirl_mute") {
    this.key = key;
    this.ctx = null;
    try { this.muted = localStorage.getItem(key) === "1"; } catch { this.muted = false; }
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        const comp = this.ctx.createDynamicsCompressor();
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        const len = this.ctx.sampleRate;
        this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } catch { this.ctx = null; }
    } else if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  }

  setMuted(m) {
    this.muted = m;
    try { localStorage.setItem(this.key, m ? "1" : "0"); } catch {}
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  get ready() { return this.ctx && this.ctx.state === "running" && !this.muted; }

  tone(f0, f1, dur, type = "sine", vol = 0.1, delay = 0) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  noise(dur, f0, f1, q = 1, vol = 0.1, delay = 0) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(this.master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
  }

  // a bubbling, filtered-noise loop whose level follows how hard you're pouring
  pour(level) {
    if (!this.ctx || this.muted) {
      if (this.pourGain) this.pourGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      return;
    }
    if (!this.pourGain) {
      const c = this.ctx;
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const f = c.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 520;
      f.Q.value = 2.4;
      const lfo = c.createOscillator();
      lfo.frequency.value = 7;
      const lg = c.createGain();
      lg.gain.value = 260;
      lfo.connect(lg);
      lg.connect(f.frequency);
      lfo.start();
      this.pourGain = c.createGain();
      this.pourGain.gain.value = 0;
      src.connect(f);
      f.connect(this.pourGain);
      this.pourGain.connect(this.master);
      src.start();
    }
    this.pourGain.gain.setTargetAtTime(level * 0.16, this.ctx.currentTime, 0.06);
  }

  vortex() {
    this.noise(0.9, 300, 2400, 1.6, 0.18);
    this.tone(160, 640, 0.7, "sine", 0.09);
    this.tone(640, 120, 0.9, "triangle", 0.05, 0.25);
  }

  beep(hi) {
    this.tone(hi ? 880 : 523.25, hi ? 880 : 523.25, hi ? 0.3 : 0.12, "triangle", 0.11);
  }

  win() {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => this.tone(f, f, 0.42, "triangle", 0.09, i * 0.09));
  }

  lose() {
    [440, 392, 349.23].forEach((f, i) => this.tone(f, f * 0.99, 0.4, "triangle", 0.07, i * 0.17));
  }
}
