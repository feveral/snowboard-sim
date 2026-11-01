// Snowboard physics. Pure JS, no rendering. Downhill = +Z, up = +Y.
//
// Model in short (v2, force based):
//  * Gravity along the slope accelerates the rider; snow friction (falls slightly with
//    speed), air drag and snow-plough resistance when sliding sideways slow it down.
//  * Load N = g·cos(slope) + v²·κ (terrain curvature): compressions add grip, crests unweight.
//  * The board is a rotating body (yaw rate ω has inertia). The engaged edge steers it toward
//    the sidecut/balance arc R = max(Rsc·cosθ, v²/(N·tanθ + g_in)); the rider adds body torque
//    (pivot, brake, low-speed steering) with limited strength.
//  * Lateral snow force follows a slip curve like a tyre: it rises with slip angle β up to
//    N·tan(θ+φ), then drops to a kinetic level. Carving settles at β of 1–3°; ask for more
//    than the edge can give and it washes out into a skid.
//  * Balance: the rider can only tip as far as the lateral force supports plus angulation,
//    so edge angle builds through the turn and you can't hold a big edge at walking speed.
//  * Slip angle β decides carving / skid-carve / skidding / scraping.
import { clamp, smoothstep } from './noise.js';

const G = 9.81;
const D2R = Math.PI / 180;
export const PARAMS = {
  sidecutR: 7.8,        // m
  maxEdge: 68 * D2R,
  edgeRate: 2.6,        // rad/s, how fast you can roll edge to edge (~0.4 s to 60°)
  pivotRate: 3.0,       // rad/s at full pull
  massDragK: 0.5 * 1.2 / 75,
  cdaUpright: 0.6,
  cdaTuck: 0.32,
  catchSlip: 3.0,       // m/s lateral slide toward the engaged edge -> catch
  slip0Edge: 0.03,      // rad: slip angle where an engaged edge reaches ~76% of its grip
  slip0Flat: 0.09,      // rad: same for a flat base
  kSidecut: 11,         // 1/s: how hard the biting edge steers the board onto its arc
  kRider: 6,            // 1/s: rider's body torque gain
  maxYawAcc: 26,        // rad/s²: strongest twist the rider can apply
  plough: 0.055,        // 1/m: sideways snow-plough drag (a = k·v_lat²)
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
    this.rideAway = 0; this.brakeEdge = 0;
    this.travel = 1;         // +1 riding forward, -1 riding switch (with hysteresis)
    this.omega = 0;          // yaw rate, + = turning right
    this.load = G;           // normal acceleration (smoothed)
    this.aLatS = 0;          // smoothed lateral snow acceleration (signed, +r)
    if (this.assist === undefined) this.assist = 0.6;
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
    this.omega = 0; this.aLatS = 0; this.load = G;
    this.rideAway = 0; this.brakeEdge = 0;
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
    // Controls are relative to what the camera shows:
    //   steer  = at speed: turn left/right (the right edge is picked automatically, also switch).
    //            slow / stopped / sideways / reversing: go toward that side of the screen (below).
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
    // which end leads: don't re-decide while braking (the board is swung across on purpose) or
    // while you're steering a slow board round toward a screen direction (that picks the end itself)
    if (!(pull > 0.05 && this.brakeEdge) && !this.rideAway) { if (refF > 0.4) this.travel = 1; else if (refF < -0.4) this.travel = -1; }
    let betaS = Math.atan2(this.travel * refR, Math.abs(refF)); // + = moving to the right of the nose
    let sideways = smoothstep(0.95, 1.3, Math.abs(betaS));       // ~55°..75°

    // ---- screen-relative steering at low speed ----
    // At speed the camera follows your path, so "turn right" and "go right on screen" are the same.
    // Slow, stopped, sideways after a side-slip, or after carving up the hill the camera looks down
    // the hill instead, and travel-relative steering would send you the wrong way on screen. There a
    // push means "go that way": the board end on that side drops toward it (riding switch if it's
    // the tail), so left is always left and right is right.
    {
      const fl = Math.atan2(n0[0], n0[2]);
      const camYaw = input.camYaw ?? fl;                       // no camera (NPCs, tests): look downhill
      const crx = -Math.cos(camYaw), crz = Math.sin(camYaw);   // screen right
      const s = Math.sign(steer);
      const vh = Math.hypot(v[0], v[2]);
      const backPush = vh > 0.5 && s * (crx * v[0] + crz * v[2]) / vh < -0.3; // pushing against where you're going on screen
      // keep heading where you pushed until you've picked up speed, then normal steering takes over
      const keep = this.rideAway === s && (spA < 4 || Math.abs(this.rideErr || 0) > 0.12) && spA < 6;
      const fresh = this.rideAway !== s;
      // where you want to go: toward the pushed side of the screen, kept on the downhill half.
      // The view is locked when you push: the camera turning with you mustn't drag the target round.
      const cam = fresh ? camYaw : this.rideCam;
      const want = cam - s * (0.3 + 0.6 * Math.min(1, Math.abs(steer))); // ~25°..50° off the view
      const rideYaw = fl + clamp(Math.atan2(Math.sin(want - fl), Math.cos(want - fl)), -0.95, 0.95); // steep enough to get going
      // the end that needs the least swing (small bias to keep the current one)
      const dN = Math.abs(Math.atan2(Math.sin(this.yaw - rideYaw), Math.cos(this.yaw - rideYaw)));
      const dLead = this.travel > 0 ? dN : Math.PI - dN;          // swing for the end that leads now
      const end = (dN - (this.travel > 0 ? 0.35 : 0)) <= (Math.PI - dN - (this.travel < 0 ? 0.35 : 0)) ? 1 : -1;
      // pushing against your travel only counts as "go the other way" when the trailing end is
      // already close to that direction (end of a turn up the hill); otherwise it's a normal turn
      const reverse = backPush && end !== this.travel && Math.PI - dLead < 0.9;
      const active = this.grounded && Math.abs(steer) > 0.15 && pull <= 0.05 && !T.surface(p[0], p[2]).box
        && (spA < 1.2 || sideways > 0.3 || (spA < 5 && reverse) || keep);
      if (!active) this.rideAway = 0;
      else {
        this.rideYaw = rideYaw;
        if (fresh) {
          this.rideCam = camYaw;
          this.rideEnd = end;
          this.rideAway = s;
          this.rideErr = 1;
        }
        this.travel = this.rideEnd;
        betaS = Math.atan2(this.travel * refR, Math.abs(refF));
        sideways = smoothstep(0.95, 1.3, Math.abs(betaS));
      }
    }
    // No automatic re-orienting: the board only turns because of the edge (carving), the
    // rider's input, or the snow. The brake edge is chosen when you start braking and stays.
    const twistWant = false, twist = false;
    tel.twist = false;
    const brake = Math.max(0, pull);
    if (Math.abs(steer) > 0.15) this.lastPivotDir = Math.sign(steer);
    const assist = this.assist;
    const grL = n0[0] * n0[1] * this.r[0] + (n0[1] * n0[1] - 1) * this.r[1] + n0[2] * n0[1] * this.r[2]; // gravity across the board
    if (brake > 0.05 && this.grounded) {
      if (!this.brakeEdge) {
        // latch the edge for this side-slip: the steer side picks it (down-right = toeside when
        // riding regular), otherwise keep the edge you're on, otherwise the uphill edge
        // remember which way you were going: the board swings across THAT line, so the stop
        // ends up square to your path instead of curling round uphill
        this.brakeYaw = spA > 1.5 ? Math.atan2(v[0], v[2]) : Math.atan2(n0[0], n0[2]);
        this.brakeEdge = Math.abs(steer) > 0.15 ? Math.sign(steer) * this.travel
          : Math.abs(this.edge) > 0.12 ? Math.sign(this.edge)
          : (-Math.sign(grL) || 1);
      }
    } else if (Math.abs(betaS) < 0.45 || !this.grounded) this.brakeEdge = 0; // back in line: release the latch
    const latched = this.brakeEdge || 0;
    // body rotation the rider asks for
    let wBody = 0, bodyGain = 0;
    // small slips only (a sketchy landing, a washed-out carve): the body tidies the board up a little.
    // Never touches a deliberate side-slip (> ~25°).
    if (this.grounded && !latched && brake <= 0.05 && Math.abs(betaS) > 0.07 && Math.abs(betaS) < 0.45) {
      wBody = clamp(3 * betaS, -1.2, 1.2);
      bodyGain = (1 - smoothstep(0.3, 0.45, Math.abs(betaS))) * (0.3 + 0.4 * assist);
    }
    if (brake > 0.05 && latched) {
      // swing the board across so the latched edge is the uphill (trailing) one
      // board goes fully across the travel direction; how far you pull sets how hard the edge digs
      const betaTarget = -latched * this.travel * 1.48 * smoothstep(0.05, 0.25, brake);
      // nearly stopped: hold the board where it is (no more swinging round)
      const noseYaw = this.yaw + (this.travel < 0 ? Math.PI : 0);
      const betaFixed = Math.atan2(Math.sin(noseYaw - this.brakeYaw), Math.cos(noseYaw - this.brakeYaw));
      wBody = clamp(4.0 * (betaFixed - betaTarget), -P.pivotRate, P.pivotRate) * smoothstep(0.8, 2.0, spA);
      bodyGain = 1;
    } else if (this.rideAway) {
      // slow / sideways / reversing: left & right mean SCREEN left & right. Swing the chosen end
      // toward the direction you pushed (flat base), then ride off that way – nose or tail.
      const endYaw = this.yaw + (this.rideEnd < 0 ? Math.PI : 0);
      const err = Math.atan2(Math.sin(endYaw - this.rideYaw), Math.cos(endYaw - this.rideYaw));
      this.rideErr = err;
      wBody = clamp(2.8 * err, -2.0, 2.0);
      bodyGain = 1;
    }

    const surfNow = T.surface(p[0], p[2]);
    const onBox = this.grounded && !!surfNow.box;
    tel.onBox = onBox;
    let edgeTarget = steer * this.travel * P.maxEdge;
    if (onBox) edgeTarget = 0; // flat base on boxes
    else if (brake > 0.05 && latched) {
      edgeTarget = latched * (8 + 36 * brake) * (Math.PI / 180);
    } else if (latched && Math.abs(betaS) > 0.45) {
      // let go mid side-slip: stay on that edge (lightly) until you steer away
      edgeTarget = latched * 12 * (Math.PI / 180) * (1 - Math.min(1, Math.abs(steer) * 1.4));
    } else {
      edgeTarget *= this.rideAway ? 0.05 : 1 - 0.9 * sideways; // board across the slide: keep it flat while you swing it round
      // balance: you can only lean as far as the snow pushes back (plus angulation at the hips/knees)
      if (this.grounded && Math.abs(edgeTarget) > 0.01) {
        const se = Math.sign(edgeTarget);
        const aE = Math.max(0, se * this.aLatS);
        const cap = Math.atan2(aE, Math.max(2, this.load)) + 0.3 + 0.14 * assist; // angulation ≈ 17–25°
        edgeTarget = se * Math.min(Math.abs(edgeTarget), cap);
      }
    }
    const eRate = P.edgeRate * (0.55 + 0.45 * clamp(this.load / G, 0, 1.4));
    this.edge += clamp(edgeTarget - this.edge, -eRate * dt, eRate * dt);
    const th = Math.abs(this.edge);
    const eSign = Math.sign(this.edge);
    tel.brake = brake;
    this.ollieCool = Math.max(0, (this.ollieCool || 0) - dt);
    tel.grab = !this.grounded && pull > 0.35;
    if (input.ollie && this.grounded && this.ollieCool <= 0) {
      // pop: spring off the tail, a bit more with speed
      const n = this.n, pop = 2.6 + Math.min(1.2, spA * 0.05);
      for (let i = 0; i < 3; i++) v[i] += n[i] * pop;
      p[1] += 0.03;
      this.grounded = false; this.airT = 0; this.ollieCool = 0.45;
      if (Math.abs(steer) > 0.4) this.omega = steer * 6.2; // pre-wound shoulders: hop 180
      tel.ollie = true;
    }

    const cda = P.cdaUpright + (P.cdaTuck - P.cdaUpright) * tuck;
    const kd = P.massDragK * cda;

    if (this.grounded) {
      this._frame();
      const n = this.n, ny = n[1];
      const speed0 = Math.hypot(v[0], v[1], v[2]);
      const vf0 = dot(v, this.f), vr0 = dot(v, this.r);
      const surf = surfNow;

      // ---- load: gravity share + terrain curvature along the travel line ----
      let kap = 0;
      if (speed0 > 1) {
        const hx = v[0] / (Math.hypot(v[0], v[2]) || 1), hz = v[2] / (Math.hypot(v[0], v[2]) || 1), d = 1.1;
        const h0 = T.height(p[0], p[2]);
        kap = (T.height(p[0] + hx * d, p[2] + hz * d) - 2 * h0 + T.height(p[0] - hx * d, p[2] - hz * d)) / (d * d);
      }
      const vh2 = v[0] * v[0] + v[2] * v[2];
      const loadNow = Math.max(0, G * ny + clamp(kap * vh2 * ny * ny, -2.5 * G, 3 * G));
      this.load += (loadNow - this.load) * (1 - Math.exp(-dt / 0.04));
      const N = this.load;

      // ---- gravity in the tangent plane ----
      const gt = [G * ny * n[0], -G + G * ny * ny, G * ny * n[2]];

      // ---- yaw dynamics ----
      const slip = Math.atan2(Math.abs(vr0), Math.abs(vf0) + 0.3);
      const carveEff = smoothstep(0.12, 0.42, th); // a low edge doesn't bend the board into its arc: it drifts
      const rGeo = P.sidecutR * Math.cos(th);
      const gIn = eSign * dot(gt, this.r);                 // gravity toward the turn centre
      const aC = N * Math.tan(th) + gIn;
      const rBal = (speed0 * speed0) / Math.max(aC, 0.4);
      const R = Math.max(rGeo, rBal);
      const wCarve = eSign * carveEff * vf0 / R;
      // the edge only steers while it's biting (small slip) and loaded
      const bend = smoothstep(3, 8, speed0);   // too slow: the board doesn't bend into its arc, it just skids round
      const bite = carveEff * bend * (1 - smoothstep(0.12, 0.45, slip)) * clamp(N / G, 0, 1.5) * (1 - 0.85 * brake);
      const kS = P.kSidecut * bite;
      // rider torque: weaker when the edge is locked in and the board is heavily loaded
      const eff = (1 - 0.55 * Math.sin(th) * bite) / (0.45 + 0.55 * clamp(N / G, 0.2, 2));
      const wSlow = bodyGain > 0 ? 0 : steer * 1.3 * Math.max(0, 1 - speed0 / 7) * (1 - sideways);
      const wRider = wBody * bodyGain + wSlow;
      const kR = P.kRider * eff * (brake > 0.05 || Math.abs(wSlow) > 0.05 || bodyGain > 0.05 ? 1 : 0.35);
      const wWant = (kS * wCarve + kR * wRider) / (kS + kR + 1e-6);
      let alpha = (kS + kR) * (wWant - this.omega);
      const aLim = tel.twist ? 7 : P.maxYawAcc + 40 * bite; // twisting the whole body+board round builds up slowly
      alpha = clamp(alpha, -aLim, aLim);
      this.omega += alpha * dt;
      const w = this.omega;
      this.yaw -= w * dt; // + w = turning right; right = -dYaw (see frame)
      this._frame();
      const f = this.f, r = this.r;
      const gf = dot(gt, f), gr = dot(gt, r);

      // ---- longitudinal: gravity, snow friction (lower when fast), ----
      let vf = dot(v, f);
      let vr = dot(v, r);
      vf += gf * dt;
      const muV = surf.mu * (1.2 - 0.35 * smoothstep(1, 18, Math.abs(vf)));
      const fr = muV * N * dt;
      if (Math.abs(vf) <= fr) vf = 0; else vf -= Math.sign(vf) * fr;

      // ---- lateral: slip-curve edge force ----
      const beta = Math.atan2(Math.abs(vr), Math.abs(vf) + 0.2);
      const aStick = -vr / dt - gr;                      // what it takes to stop sideways motion now
      let tanLim;
      if (th > 0.02 && Math.sign(aStick) === eSign) tanLim = Math.tan(Math.min(th * (1 - 0.3 * surf.ice) + surf.phi, 1.35));
      else tanLim = Math.tan(Math.max(surf.phi - th * 0.6, 0.05));
      // the snow itself can only take so much shear before the edge cuts through: ~2g groomed, less on ice
      tanLim = Math.min(tanLim, 2.0 - 1.1 * surf.ice + 0.3 * surf.off * 0);
      const b0 = th > 0.1 ? P.slip0Edge : P.slip0Flat + (P.slip0Edge - P.slip0Flat) * th / 0.1;
      let shape = Math.tanh(beta / b0) * (1 - 0.22 * smoothstep(4 * b0, 0.6, beta));
      const spLat = Math.hypot(vf, vr);
      shape = Math.max(shape, 1 - smoothstep(0.3, 1.2, spLat));   // static hold when (almost) stopped
      const aMax = N * tanLim * shape;
      const aLat = clamp(aStick, -aMax, aMax);
      vr += (gr + aLat) * dt;
      const grip = beta < 3 * b0;
      // snow plough: sliding sideways pushes a wall of snow (≈ v_lat²), stronger in soft snow
      if (beta > 0.12) {
        const dig = 0.12 + 0.88 * smoothstep(0.05, 0.4, th);
        const pl = Math.min(Math.abs(vr), P.plough * dig * (1 + 1.5 * surf.off) * vr * vr * dt);
        vr -= Math.sign(vr) * pl;
        const lossF = Math.min(Math.abs(vf), 0.25 * pl);
        vf -= Math.sign(vf) * lossF;
      }

      // air drag on whole velocity
      const spd = Math.hypot(vf, vr);
      const dragDv = kd * spd * spd * dt;
      if (spd > 1e-6) {
        const sc = Math.max(0, spd - dragDv) / spd;
        vf *= sc; vr *= sc;
      }

      for (let i = 0; i < 3; i++) v[i] = f[i] * vf + r[i] * vr;
      this.aLatS += (aLat - this.aLatS) * (1 - Math.exp(-dt / 0.08));

      // catch an edge: sliding sideways toward the edge you're standing on
      const catchV = P.catchSlip + 1.5 * assist;
      if (!grip && th > 0.45 && Math.sign(vr) === eSign && Math.abs(vr) > catchV && spd > 5) {
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
      let betaT = Math.atan2(Math.abs(vrN), Math.abs(vfN)); // 0..90°, switch-safe
      if (speed < 0.5) betaT = 0;
      const a = 1 - Math.exp(-dt / 0.12);
      this.betaS += (betaT - this.betaS) * a;
      const latG = aLat / G;
      const wPivot = (kR * wRider) / (kS + kR + 1e-6);
      const pivotShare = brake > 0.05 ? Math.abs(wPivot) / (Math.abs(w) + 0.05) : 0;
      tel.speed = speed; tel.beta = betaT; tel.betaS = this.betaS; tel.latG = latG;
      tel.grip = grip; tel.skid = Math.abs(vrN); tel.omega = w;
      tel.omegaCarve = wCarve; tel.omegaPivot = wPivot; tel.load = N / G;
      tel.radius = Math.abs(w) > 0.03 ? speed / Math.abs(w) : Infinity;
      tel.ice = surf.ice; tel.off = surf.off;
      tel.carveQ = clamp(carveEff * smoothstep(3.5, 8, speed) * (1 - this.betaS / (14 * D2R)) * (1 - 0.8 * pivotShare), 0, 1);

      const bd = this.betaS / D2R;
      let m;
      if (speed < 1.2) m = MODES.stop;
      else if (bd < 3.5) {
        if (th > 18 * D2R && Math.abs(wCarve) > 0.1 && pivotShare < 0.45 && speed > 5 && bite > 0.4) m = MODES.carve;
        else if ((pivotShare >= 0.45 || (speed <= 5 && th > 13 * D2R)) && Math.abs(w) > 0.15) m = MODES.semicarve; // pivoting / too slow to carve
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
      // spin: you keep the rotation you took off with; arms/shoulders can wind it up or slow it
      if (Math.abs(steer) > 0.1) {
        const wT = steer * (tel.grab ? 4.6 : 6.6);
        this.omega += clamp(wT - this.omega, -16 * dt, 16 * dt);
      } else {
        // let go: keep the spin and spot the landing on the nearest end (nose or tail)
        const yawV = Math.atan2(v[0], v[2]);
        const d = Math.atan2(Math.sin(this.yaw - yawV), Math.cos(this.yaw - yawV));
        const tgt = Math.abs(d) > Math.PI / 2 ? Math.sign(d) * Math.PI : 0;
        const wT = clamp(5 * (d - tgt), -6.6, 6.6);
        this.omega += clamp(wT - this.omega, -14 * dt, 14 * dt) * (0.45 + 0.55 * this.assist);
      }
      this.yaw -= this.omega * dt;
      this.load = 0; this.aLatS = 0;
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
        this.load = G + impact * 6; // landing compression
        if (Math.hypot(vf, vr) > 4 && landBeta > (42 + 16 * this.assist) * D2R) this.crash('落地方向歪了');
        else if (tel.grab && impact > 4) this.crash('還抓著板落地');
        else if (impact > 11) this.crash('落地太重');
        else {
          const keep = 1 - Math.min(0.35, impact * 0.025);
          for (let i = 0; i < 3; i++) v[i] *= keep;
          this.omega *= 0.5;
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
