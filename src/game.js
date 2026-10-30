// Scoring: rate every turn (carve vs skid), slalom gates, air time, combos.
import { gatesInRange, GATE_HALF, activeBranch, pisteInfo } from './terrain.js';

const D = 180 / Math.PI;

export class Game {
  constructor(rider, onEvent) {
    this.rider = rider;
    this.emit = onEvent;
    this.reset();
    try { this.best = +localStorage.getItem('sb_best') || 0; } catch { this.best = 0; }
  }
  reset() {
    this.score = 0; this.combo = 0; this.bestCombo = 0;
    this.turn = null; this.lastZ = this.rider.p[2];
    this.gateDone = new Map();
    this.airStartYaw = 0; this.wasAir = false; this.wasCrash = false;
    this.cleanTurns = 0; this.gatesHit = 0; this.gatesMissed = 0;
    this.lastBranch = null;
  }
  get mult() { return 1 + Math.min(3, this.combo * 0.25); }
  add(pts, label, kind) {
    const p = Math.round(pts * this.mult);
    this.score += p;
    this.emit({ kind, label, pts: p, mult: this.mult });
    if (this.score > this.best) { this.best = this.score; try { localStorage.setItem('sb_best', String(this.best)); } catch {} }
  }
  breakCombo(reason) {
    if (this.combo >= 3) this.emit({ kind: 'bad', label: `${reason} · combo ×${this.combo} 中斷`, pts: 0 });
    this.combo = 0;
  }
  update(dt) {
    const r = this.rider, t = r.tel;
    // ---- crash
    const crashed = r.crashT > 0;
    if (crashed && !this.wasCrash) { this.breakCombo('摔倒'); this.turn = null; this.emit({ kind: 'crash' }); }
    this.wasCrash = crashed;
    if (crashed) { this.lastZ = r.p[2]; return; }

    // ---- air
    if (!r.grounded) {
      if (!this.wasAir) { this.airStartYaw = r.yaw; this.airYaw = 0; this.prevYaw = r.yaw; this.grabT = 0; this.ollied = !!r.tel.ollie; this.airTravel = r.travel; }
      this.airYaw += r.yaw - this.prevYaw; this.prevYaw = r.yaw;
      if (r.tel.grab) this.grabT += dt;
      this.wasAir = true;
    } else if (this.wasAir) {
      this.wasAir = false;
      const air = r.airT;
      if (air > 0.35) {
        const spin = Math.round(Math.abs(this.airYaw) * D / 180) * 180;
        const parts = [];
        let pts = air * 250;
        if (spin >= 180) {
          const fs = this.airYaw * this.airTravel > 0; // chest opens down the hill = frontside (regular)
          parts.push(`${fs ? 'FS' : 'BS'} ${spin}`);
          pts += spin * 2.2;
        }
        if (this.grabT > 0.25) {
          const grabs = ['Indy', 'Melon', 'Mute', 'Tail', 'Nose', 'Stalefish'];
          parts.push(grabs[Math.floor((this.grabT * 7 + spin / 180) % grabs.length)] + ' Grab');
          pts += 150 + this.grabT * 300;
        }
        if (!parts.length) parts.push(this.ollied && air < 0.7 ? 'Ollie' : 'Air');
        this.add(pts, `${parts.join(' ')} · ${air.toFixed(1)}s`, 'air');
        this.combo++;
      }
    }

    // ---- boxes: 50-50 (board straight) or boardslide (board across)
    if (r.grounded && r.tel.onBox) {
      if (!this.slide) this.slide = { t: 0, dist: 0, across: 0 };
      this.slide.t += dt; this.slide.dist += r.tel.speed * dt;
      if (r.tel.betaS > 0.9) this.slide.across += dt;
    } else if (this.slide) {
      const S = this.slide; this.slide = null;
      if (S.t > 0.25 && S.dist > 1.5) {
        const bs = S.across > S.t * 0.5;
        this.combo++;
        this.add(S.dist * (bs ? 60 : 35), `${bs ? 'Boardslide' : '50-50'} ${S.dist.toFixed(1)}m`, 'air');
      }
    }

    // ---- turns: a turn is the stretch between edge changes
    const e = r.edge * D;
    const side = e > 9 ? 1 : e < -9 ? -1 : 0;
    const ds = t.speed * dt;
    if (side !== 0 && r.grounded) {
      if (!this.turn || this.turn.side !== side) {
        if (this.turn) this.finishTurn(this.turn);
        this.turn = { side, dist: 0, carve: 0, skid: 0, maxEdge: 0, maxG: 0, heading0: r.yaw };
      }
      const T = this.turn;
      T.dist += ds;
      if (r.mode.key === 'carve') T.carve += ds;
      if (r.mode.key === 'skid' || r.mode.key === 'scrape') T.skid += ds;
      T.maxEdge = Math.max(T.maxEdge, Math.abs(e));
      T.maxG = Math.max(T.maxG, Math.min(2.5, Math.abs(t.latG)));
      T.heading1 = r.yaw;
    }

    // ---- gates
    const z0 = this.lastZ, z1 = r.p[2];
    if (z1 > z0) {
      gatesInRange(z0 - 1, z1 + 1, (g) => {
        if (this.gateDone.has(g.k) || !(z0 < g.z && z1 >= g.z)) return;
        const ok = Math.abs(r.p[0] - g.x) <= GATE_HALF + 0.3;
        this.gateDone.set(g.k, ok ? 'pass' : 'miss');
        if (ok) { this.gatesHit++; this.combo++; this.add(150, '旗門 ✓', 'gate'); }
        else if (Math.abs(r.p[0] - g.x) < 14) { this.gatesMissed++; this.breakCombo('漏旗門'); this.emit({ kind: 'miss', label: '漏掉旗門', pts: 0 }); }
        this.emit({ kind: 'gateState', k: g.k, state: ok ? 'pass' : 'miss' });
      });
    }
    this.lastZ = z1;

    // ---- entering a side run
    const b = activeBranch(r.p[2]);
    const pi = b ? pisteInfo(r.p[0], r.p[2]) : null;
    const onBranch = pi && pi.branch && pi.branch.k === b.k && pi.w > 0.7;
    if (onBranch && this.lastBranch !== b.k) {
      this.lastBranch = b.k;
      this.emit({ kind: 'info', label: `進入 ${b.type.name}` });
      this.add(300, `新雪道：${b.type.en}`, 'bonus');
    }
  }
  finishTurn(T) {
    if (T.dist < 6 || this.rider.tel.speed < 3) return;
    const cf = T.carve / T.dist, sf = T.skid / T.dist;
    const sweep = Math.abs(T.heading1 - T.heading0) * D;
    if (sweep < 18) return; // not really a turn
    if (cf > 0.75) {
      this.cleanTurns++; this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      const pts = T.dist * (2 + T.maxEdge / 18) * (0.6 + T.maxG);
      const tag = T.maxEdge > 55 ? 'EURO CARVE' : T.maxEdge > 40 ? 'DEEP CARVE' : 'CLEAN CARVE';
      this.add(pts, `${tag} ${T.maxEdge.toFixed(0)}° ${T.maxG.toFixed(1)}G`, 'carve');
    } else if (cf > 0.35) {
      this.add(T.dist * 1.2, '半刻滑轉彎', 'semi');
    } else if (sf > 0.5) {
      this.breakCombo('搓雪');
      this.add(T.dist * 0.4, '搓雪轉彎', 'skid');
    }
  }
}
