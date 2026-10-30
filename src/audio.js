// Procedural snow sounds: wind, carve hiss, skid scrape, landing thump.
export class SnowAudio {
  constructor() { this.ctx = null; this.on = true; }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2.5; }
    const src = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * 2); return s; };
    this.master = ctx.createGain(); this.master.gain.value = this.on ? 0.9 : 0; this.master.connect(ctx.destination);
    const chain = (type, f, q) => {
      const s = src(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
      fl.type = type; fl.frequency.value = f; fl.Q.value = q; g.gain.value = 0;
      s.connect(fl); fl.connect(g); g.connect(this.master);
      return { fl, g };
    };
    this.wind = chain('lowpass', 500, 0.7);
    this.carve = chain('bandpass', 3800, 1.4);
    this.glide = chain('bandpass', 1400, 0.6);
    this.skid = chain('lowpass', 900, 1.2);
    this.skidMod = 0;
  }
  setOn(v) { this.on = v; if (this.master) this.master.gain.setTargetAtTime(v ? 0.9 : 0, this.ctx.currentTime, 0.05); }
  update(r, modeKey, dt) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, sp = r.tel.speed;
    const gnd = r.grounded && r.crashT <= 0;
    const set = (n, v, tc = 0.06) => n.g.gain.setTargetAtTime(v, t, tc);
    set(this.wind, Math.min(0.5, (sp / 25) ** 2 * 0.45) + 0.02, 0.2);
    this.wind.fl.frequency.setTargetAtTime(300 + sp * 25, t, 0.2);
    const carving = gnd && modeKey === 'carve';
    set(this.carve, carving ? Math.min(0.22, 0.03 + sp * 0.008 * Math.min(1.5, Math.abs(r.tel.latG))) : 0);
    this.carve.fl.frequency.setTargetAtTime(3000 + Math.abs(r.edge) * 2200, t, 0.1);
    set(this.glide, gnd ? Math.min(0.12, sp * 0.006) : 0);
    this.skidMod += dt * (8 + Math.random() * 30);
    const sk = gnd ? Math.min(1, r.tel.skid / 3) * Math.min(1, sp / 6) : 0;
    set(this.skid, sk * (0.35 + 0.15 * Math.sin(this.skidMod)), 0.03);
    this.skid.fl.frequency.setTargetAtTime(500 + sk * 900 + (r.tel.ice > 0.4 ? 1500 : 0), t, 0.05);
  }
  thump(k = 1) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    g.gain.setValueAtTime(0.5 * k, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.3);
  }
  ding(hi = false) {
    if (!this.ctx || !this.on) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'triangle'; o.frequency.value = hi ? 1320 : 880;
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.4);
  }
}
