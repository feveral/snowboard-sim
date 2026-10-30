// Snowboard physics. Pure JS, no rendering. Downhill = +Z, up = +Y.
//
// Model in short:
//  * Board heading yaw rotates from (a) the sidecut/balance of the edge
//    (carve: R = max(Rsidecut·cosθ, v²/(g·tanθ))) and (b) the rider pivoting
//    the board with the body (skid turns).
//  * The edge can hold a lateral/normal force ratio of tan(θ + φ) where θ is
//    edge angle and φ is the snow's "hold" angle. If the turn needs more than
//    that, the board slides sideways -> skidding / scraping.
//  * Slip angle β (board heading vs. travel direction) decides
//    carving / skid-carve / skidding / scraping.
import { clamp, smoothstep } from './noise.js';

const G = 9.81;
const D2R = Math.PI / 180;
export const PARAMS = {
  sidecutR: 7.8,        // m
  maxEdge: 68 * D2R,
  edgeRate: 4.0,        // rad/s, how fast you can roll edge to edge
  pivotRate: 3.0,       // rad/s at full pull
  massDragK: 0.5 * 1.2 / 75,
  cdaUpright: 0.6,
  cdaTuck: 0.32,
  catchSlip: 3.0,       // m/s lateral slide toward the engaged edge -> catch
};

export const MODES = {
  stop: { key: 'stop', label: '停止', en: 'STOPPED' },
  glide: { key: 'glide', label: '平板直滑', en: 'GLIDE' },
  carve: { key: 'carve', label: 'Carving 刻滑', en: 'CARVE' },
  semicarve: { key: 'semicarve', label: '半刻滑', en: 'SKID-CARVE' },
  skid: { key: 'skid', label: '搓雪', en: 'SKIDDING' },
  scrape: { key: 'scrape', label: '掃雪 / 推坡', en: 'SCRAPING' },
  air: { key: 'air', label: '騰空', en: 'AIR' },
  crash: { key: 'crash', label: '摔倒', en: 'WIPEOUT' },
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function cross(a, b, o) {
  o[0] = a[1] * b[2] - a[2] * b[1];
  o[1] = a[2] * b[0] - a[0] * b[2];
  o[2] = a[0] * b[1] - a[1] * b[0];
  return o;
}
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  a[0] /= l; a[1] /= l; a[2] /= l;
  return a;
}

export class Rider {
  constructor(terrain) {
    this.T = terrain;
    this.n = [0, 1, 0];
    this.f = [0, 0, 1];
    this.r = [-1, 0, 0];
    this.reset();
  }

  reset(z = 4) {
    this.p = [this.T.pisteCenter(z), 0, z];
    this.p[1] = this.T.height(this.p[0], this.p[2]);
    this.v = [0, 0, 0];
    this.yaw = 0.6;          // pointing a bit across the hill
    this.edge = 0;           // rad, + = lean to rider's right (toeside, regular)
    this.grounded = true;
    this.crashT = 0;
    this.crashReason = '';
    this.airT = 0;
    this.lastPivotDir = 1;
    this.travel = 1;         // +1 riding forward, -1 riding switch (with hysteresis)
    this.betaS = 0;          // smoothed |slip angle|
    this.mode = MODES.stop;
    this.stats = { dist: 0, turnDist: 0, carveDist: 0, maxSpeed: 0, maxG: 0, crashes: 0, maxAir: 0 };
    this.tel = {
      speed: 0, beta: 0, betaS: 0, latG: 0, radius: Infinity, grip: true,
      skid: 0, carveQ: 0, omega: 0, omegaCarve: 0, omegaPivot: 0, ice: 0, off: 0,
      landed: 0,
    };
    this._frame();
  }

  _frame() {
    const T = this.T, p = this.p;
    T.normal(p[0], p[2], this.n);
    const f0 = [Math.sin(this.yaw), 0, Math.cos(this.yaw)];
    const k = dot(f0, this.n);
    this.f[0] = f0[0] - k * this.n[0];
    this.f[1] = f0[1] - k * this.n[1];
    this.f[2] = f0[2] - k * this.n[2];
    norm(this.f);
    cross(this.f, this.n, this.r); // rider's right
  }

  fallLineYaw() {
    const n = this.n;
    return Math.atan2(n[0], n[2]);
  }

  crash(reason) {
    if (this.crashT > 0) return;
    this.crashT = 1.8;
    this.crashReason = reason;
    this.stats.crashes++;
  }

  recover() {
    this._frame();
    // get back up pointing ~30° off the fall line, already rolling
    const fl = this.fallLineYaw();
    this.yaw = fl + 0.5 * (Math.sign(Math.sin(this.yaw - fl)) || 1);
    this.edge = 0;
    this.travel = 1;
    this.betaS = 0;
    this._frame();
    this.v = [this.f[0] * 2.5, this.f[1] * 2.5, this.f[2] * 2.5];
    this.grounded = true;
    // shove away from trees
    for (let i = 0; i < 10; i++) {
      const hit = this.T.treeHit(this.p[0], this.p[2], 0.6);
      if (!hit) break;
      const dx = this.p[0] - hit.x, dz = this.p[2] - hit.z;
      const d = Math.hypot(dx, dz) || 1;
      this.p[0] += (dx / d) * 0.6; this.p[2] += (dz / d) * 0.6;
    }
    this.p[1] = this.T.height(this.p[0], this.p[2]);
  }

  step(dt, input) {
    const T = this.T, P = PARAMS, p = this.p, v = this.v, tel = this.tel;
    const steer = clamp(input.steer || 0, -1, 1);
    const pull = clamp(input.pull || 0, -1, 1);
    const pivot = Math.max(0, pull);
    const tuck = Math.max(0, -pull);
    tel.landed = 0;

    // ---------------- crashed: tumble to a stop ----------------
    if (this.crashT > 0) {
      this.crashT -= dt;
      const sp = Math.hypot(v[0], v[1], v[2]);
      const dec = Math.min(sp, 7 * dt);
      if (sp > 0) for (let i = 0; i < 3; i++) v[i] -= (v[i] / sp) * dec;
      p[0] += v[0] * dt; p[2] += v[2] * dt;
      p[1] = T.height(p[0], p[2]);
      this._frame();
      this.mode = MODES.crash;
      tel.speed = Math.hypot(v[0], v[1], v[2]);
      if (this.crashT <= 0) this.recover();
      return;
    }

    // ---------------- intent -> edge + pivot ----------------
    // Controls are relative to the direction of travel (what the camera shows):
    //   steer  = turn left/right (the right edge is picked automatically, also when riding switch)
    //   pull   = brake: swing the board across (side-slip / hockey stop) on the UPHILL edge;
    //            let go and the board swings back in line with the travel direction.
    this._frame();
    const n0 = this.n;
    let refF = dot(v, this.f), refR = dot(v, this.r);
    const spA = Math.hypot(refF, refR);
    if (spA < 1.5) {
      // nearly stopped: the fall line is the reference "travel" direction
      const gt0 = [n0[0], n0[1] * n0[1] - 1, n0[2]];
      const gl = Math.hypot(gt0[0], gt0[1], gt0[2]) || 1;
      const wgt = (1.5 - spA) / 1.5 * 1.5 / gl;
      refF += dot(gt0, this.f) * wgt; refR += dot(gt0, this.r) * wgt;
    }
    if (refF > 0.4) this.travel = 1; else if (refF < -0.4) this.travel = -1;
    let betaS = Math.atan2(this.travel * refR, Math.abs(refF)); // + = moving to the right of the nose
    const sideways = smoothstep(0.95, 1.3, Math.abs(betaS));     // ~55°..75°
    if (sideways > 0.5 && Math.abs(steer) > 0.3 && Math.abs(refF) < 0.4 * Math.hypot(refF, refR)) {
      // board across the slide: the end on the side you push becomes the new nose
      // (right end of the board = the one on the right of the travel direction)
      const rightEnd = refR > 0 ? -1 : 1; // f lies to the right of motion when motion is to the board's left
      this.travel = Math.sign(steer) * rightEnd;
      betaS = Math.atan2(this.travel * refR, Math.abs(refF));
    }
    const brake = Math.max(0, pull);
    if (Math.abs(steer) > 0.15) this.lastPivotDir = Math.sign(steer);
    const betaTarget = -this.lastPivotDir * brake * 1.48; // up to ~85°: nose swings toward the steer side
    let wPivotRaw = clamp(4.0 * (betaS - betaTarget), -P.pivotRate, P.pivotRate);
    const alignGain = brake > 0.05 ? 1 : smoothstep(0.07, 0.22, Math.abs(betaS)) * 0.75;
    const wPivotAll = this.grounded && spA + 1 > 0 ? wPivotRaw * alignGain : 0;

    let edgeTarget = steer * this.travel * P.maxEdge;
    if (brake > 0.05) {
      // engage the trailing (uphill) edge: opposite to the board's sideways motion
      const slideR = dot(v, this.r);
      const grL = n0[0] * n0[1] * this.r[0] + (n0[1] * n0[1] - 1) * this.r[1] + n0[2] * n0[1] * this.r[2]; // gravity across the board
      const sgn = Math.abs(slideR) > 0.4 ? -Math.sign(slideR)
        : spA < 1.5 ? (-Math.sign(grL) || 1)
        : (Math.sign(wPivotRaw) || this.lastPivotDir) * this.travel;
      const be = sgn * (8 + 36 * brake) * (Math.PI / 180);
      edgeTarget += (be - edgeTarget) * smoothstep(0.05, 0.3, brake);
    } else if (sideways > 0) {
      const uphill = -Math.sign(dot(v, this.r)) || 1;
      const ss = uphill * Math.abs(steer) * 14 * (Math.PI / 180);
      edgeTarget += (ss - edgeTarget) * sideways;
    }
    this.edge += clamp(edgeTarget - this.edge, -P.edgeRate * dt, P.edgeRate * dt);
    const th = Math.abs(this.edge);
    const eSign = Math.sign(this.edge);
    tel.brake = brake;

    const cda = P.cdaUpright + (P.cdaTuck - P.cdaUpright) * tuck;
    const kd = P.massDragK * cda;

    if (this.grounded) {
      this._frame();
      const n = this.n, ny = n[1];
      const speed0 = Math.hypot(v[0], v[1], v[2]);
      const vf0 = dot(v, this.f);

      // ---- gravity in the tangent plane ----
      const gt = [G * ny * n[0], -G + G * ny * ny, G * ny * n[2]];
      const surf = T.surface(p[0], p[2]);

      // ---- yaw rate ----
      // Carve: the rider's lean (≈ edge angle) balances the snow reaction
      // (g·tanθ) plus whatever part of gravity points into the turn.
      const carveEff = smoothstep(0.05, 0.26, th);
      const rGeo = P.sidecutR * Math.cos(th);
      const gIn = eSign * dot(gt, this.r);                 // gravity toward the turn centre
      const aC = G * ny * Math.tan(th) + gIn;
      const rBal = (speed0 * speed0) / Math.max(aC, 0.4);
      const R = Math.max(rGeo, rBal);
      const wCarve = eSign * carveEff * vf0 / R;
      const wPivot = wPivotAll * (1 - 0.4 * Math.sin(th) * (1 - brake));
      const wSlow = steer * 1.4 * Math.max(0, 1 - speed0 / 7) * (1 - sideways); // body-steer at low speed
      const w = wCarve + wPivot + wSlow;
      this.yaw -= w * dt; // + w = turning right; right = -dYaw (see frame)
      this._frame();
      const f = this.f, r = this.r;
      const gf = dot(gt, f), gr = dot(gt, r);

      // ---- longitudinal ----
      let vf = dot(v, f);
      let vr = dot(v, r);
      vf += gf * dt;
      const fr = surf.mu * G * ny * dt;
      if (Math.abs(vf) <= fr) vf = 0; else vf -= Math.sign(vf) * fr;

      // ---- lateral: can the edge hold it? ----
      const aNeed = -vr / dt - gr;
      let tanLim;
      if (th > 0.02 && Math.sign(aNeed) === eSign) tanLim = Math.tan(Math.min(th * (1 - 0.3 * surf.ice) + surf.phi, 1.35));
      else tanLim = Math.tan(Math.max(surf.phi - th * 0.6, 0.05));
      const aMax = G * ny * tanLim;
      let aLat, grip;
      if (Math.abs(aNeed) <= aMax) {
        aLat = aNeed; vr = 0; grip = true;
      } else {
        aLat = Math.sign(aNeed) * aMax * 0.85; // kinetic < static
        vr += (gr + aLat) * dt;
        grip = false;
      }
      // scraping snow costs some forward speed too
      if (!grip) {
        const loss = Math.min(Math.abs(vf), 0.35 * Math.abs(vr) * dt * G * 0.25);
        vf -= Math.sign(vf) * loss;
      }

      // air drag on whole velocity
      const spd = Math.hypot(vf, vr);
      const dragDv = kd * spd * spd * dt;
      if (spd > 1e-6) {
        const sc = Math.max(0, spd - dragDv) / spd;
        vf *= sc; vr *= sc;
      }

      for (let i = 0; i < 3; i++) v[i] = f[i] * vf + r[i] * vr;

      // catch an edge: sliding sideways toward the edge you're standing on
      if (!grip && th > 0.45 && Math.sign(vr) === eSign && Math.abs(vr) > P.catchSlip && spd > 5) {
        this.crash('逆刃 Caught an edge');
      }

      // ---- move & follow terrain / take off ----
      const ox = p[0], oz = p[2];
      p[0] += v[0] * dt; p[2] += v[2] * dt;
      const yBall = p[1] + v[1] * dt;
      const hNew = T.height(p[0], p[2]);
      const gap = yBall - hNew;
      if (gap > 0.5 * G * dt * dt + 0.004 && spd > 4) {
        this.grounded = false;
        this.airT = 0;
        p[1] = yBall;
      } else {
        p[1] = hNew;
        T.normal(p[0], p[2], n);
        const vn = dot(v, n);
        const sp = Math.hypot(v[0], v[1], v[2]);
        for (let i = 0; i < 3; i++) v[i] -= vn * n[i];
        if (vn > 0) { // convex: keep speed
          const sp2 = Math.hypot(v[0], v[1], v[2]) || 1;
          for (let i = 0; i < 3; i++) v[i] *= sp / sp2;
        }
      }

      // ---- telemetry / classification ----
      const vfN = dot(v, f), vrN = dot(v, r);
      const speed = Math.hypot(v[0], v[1], v[2]);
      let beta = Math.atan2(Math.abs(vrN), Math.abs(vfN)); // 0..90°, switch-safe
      if (speed < 0.5) beta = 0;
      const a = 1 - Math.exp(-dt / 0.12);
      this.betaS += (beta - this.betaS) * a;
      const latG = aLat / G;
      const pivotShare = brake > 0.05 ? Math.abs(wPivot) / (Math.abs(w) + 0.05) : 0;
      tel.speed = speed; tel.beta = beta; tel.betaS = this.betaS; tel.latG = latG;
      tel.grip = grip; tel.skid = Math.abs(vrN); tel.omega = w;
      tel.omegaCarve = wCarve; tel.omegaPivot = wPivot;
      tel.radius = Math.abs(w) > 0.03 ? speed / Math.abs(w) : Infinity;
      tel.ice = surf.ice; tel.off = surf.off;
      tel.carveQ = clamp(carveEff * (1 - this.betaS / (14 * D2R)) * (1 - 0.8 * pivotShare), 0, 1);

      const bd = this.betaS / D2R;
      let m;
      if (speed < 1.2) m = MODES.stop;
      else if (bd < 3.5) {
        if (th > 13 * D2R && Math.abs(wCarve) > 0.1 && pivotShare < 0.45) m = MODES.carve;
        else if (pivotShare >= 0.45 && Math.abs(w) > 0.15) m = MODES.semicarve;
        else m = MODES.glide;
      } else if (bd < 10) m = MODES.semicarve;
      else if (bd < 35) m = MODES.skid;
      else m = MODES.scrape;
      this.mode = m;

      const ds = Math.hypot(p[0] - ox, p[2] - oz);
      this.stats.dist += ds;
      if (Math.abs(w) > 0.12 && speed > 3) {
        this.stats.turnDist += ds;
        if (m === MODES.carve) this.stats.carveDist += ds;
      }
      this.stats.maxSpeed = Math.max(this.stats.maxSpeed, speed);
      this.stats.maxG = Math.max(this.stats.maxG, Math.abs(latG));
    } else {
      // ---------------- airborne ----------------
      this.airT += dt;
      v[1] -= G * dt;
      const sp = Math.hypot(v[0], v[1], v[2]);
      const sc = Math.max(0, sp - kd * sp * sp * dt) / (sp || 1);
      for (let i = 0; i < 3; i++) v[i] *= sc;
      this.yaw -= steer * this.travel * 3.2 * dt; // spin
      p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
      this.mode = MODES.air;
      tel.speed = sp;
      this.stats.maxAir = Math.max(this.stats.maxAir, this.airT);
      const h = T.height(p[0], p[2]);
      if (p[1] <= h) {
        p[1] = h;
        this.grounded = true;
        this._frame();
        const n = this.n;
        const vn = dot(v, n);
        for (let i = 0; i < 3; i++) v[i] -= vn * n[i];
        const impact = -vn;
        const vf = dot(v, this.f), vr = dot(v, this.r);
        const landBeta = Math.atan2(Math.abs(vr), Math.abs(vf));
        tel.landed = impact;
        if (Math.hypot(vf, vr) > 4 && landBeta > 50 * D2R) this.crash('落地方向歪了');
        else if (impact > 11) this.crash('落地太重');
        else {
          const keep = 1 - Math.min(0.35, impact * 0.025);
          for (let i = 0; i < 3; i++) v[i] *= keep;
        }
      }
    }

    // ---------------- trees ----------------
    const hit = T.treeHit(p[0], p[2], 0.3);
    if (hit) {
      const sp = Math.hypot(v[0], v[1], v[2]);
      const dx = p[0] - hit.x, dz = p[2] - hit.z;
      const d = Math.hypot(dx, dz) || 1;
      const push = hit.r + 0.3 - d;
      p[0] += (dx / d) * push; p[2] += (dz / d) * push;
      if (sp > 4) this.crash(hit.type === 'rock' ? '撞到石頭' : hit.type === 'tower' ? '撞到纜車柱' : '撞樹');
      else for (let i = 0; i < 3; i++) v[i] *= 0.2;
    }
  }
}
