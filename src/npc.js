// Computer-controlled riders that share the player's physics, plus the shared
// "physics state -> animated model" mapping.
import * as THREE from 'three';
import { Rider, MODES } from './physics.js';
import { terrain, pisteCenter, activeBranch, branchCenter, height, parkAt, PARK_HALF, kickerAt, KICK_SPACING } from './terrain.js';
import { createRiderModel, createSkierModel, OUTFITS } from './riderModel.js';
import { Tracks } from './fx.js';
import { clamp } from './noise.js';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- animation
const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _l = new THREE.Vector3(), _m = new THREE.Matrix4();
export function newVis() {
  return { n: new THREE.Vector3(0, 1, 0), edge: 0, lean: 0, crouch: 0.3, crash: 0, drag: 0, arms: 0.3, twist: 0.5, t: Math.random() * 10 };
}
export function animateRider(model, rider, vis, input, dt) {
  const p = rider.p, t = rider.tel;
  vis.t += dt;
  _n.set(rider.n[0], rider.n[1], rider.n[2]);
  if (!rider.grounded) _n.set(0, 1, 0).lerp(_n, 0.5).normalize();
  vis.n.lerp(_n, 1 - Math.exp(-dt * 12)).normalize();
  _f.set(Math.sin(rider.yaw), 0, Math.cos(rider.yaw));
  _f.addScaledVector(vis.n, -_f.dot(vis.n)).normalize();
  _l.crossVectors(vis.n, _f).normalize();
  _m.makeBasis(_l, vis.n, _f);
  model.root.quaternion.setFromRotationMatrix(_m);
  model.root.position.set(p[0], p[1], p[2]);
  const crashed = rider.crashT > 0;
  const k = (rate) => 1 - Math.exp(-dt * rate);
  vis.crash += ((crashed ? 1 : 0) - vis.crash) * k(crashed ? 9 : 4);
  vis.edge += (rider.edge - vis.edge) * k(20);
  let leanT = rider.grounded ? Math.atan(clamp(t.latG, -2.2, 2.2)) * 0.85 : vis.edge * 0.3;
  leanT = leanT * (1 - vis.crash) + vis.crash * (rider.edge >= 0 ? 1.35 : -1.35);
  vis.lean += (leanT - vis.lean) * k(10);
  const tuck = Math.max(0, -(input.pull || 0));
  const crouchT = clamp(0.25 + 0.45 * tuck + 0.15 * Math.min(1.6, Math.abs(t.latG)) + 0.3 * (t.brake || 0) + (rider.grounded ? 0 : 0.35) + vis.crash * 0.4, 0, 1);
  vis.crouch += (crouchT - vis.crouch) * k(8);
  const euro = model.kind === 'board' && rider.grounded && !crashed && rider.edge > 0.95 && rider.mode === MODES.carve ? 1 : 0;
  vis.drag += (euro - vis.drag) * k(6);
  vis.arms += ((rider.grounded ? 0.25 + 0.4 * Math.min(1, t.skid / 3) : 0.85) - vis.arms) * k(6);
  const twistT = model.kind === 'ski' ? clamp(t.omega, -1, 1) * 0.3 : (rider.travel > 0 ? 0.55 : -0.55) + 0.25 * clamp(t.omega, -1, 1) * rider.travel;
  vis.twist += (twistT - vis.twist) * k(5);
  vis.grab = (vis.grab || 0) + ((t.grab ? 1 : 0) - (vis.grab || 0)) * k(10);
  model.pose({ grab: vis.grab, edge: vis.edge * (1 - vis.crash), lean: vis.lean, crouch: Math.max(vis.crouch, vis.grab * 0.95), twist: vis.twist, arms: vis.arms, drag: vis.drag, crash: vis.crash, air: rider.grounded ? 0 : 1, fore: tuck * 0.6, t: vis.t });
}

// ---------------------------------------------------------------- bots
const STYLES = [
  { key: 'carver', kind: 'board', edge: 0.72, pull: 0, across: 52, maxV: 21, lane: 9, name: 'Carver' },
  { key: 'racer', kind: 'ski', edge: 0.8, pull: 0, across: 38, maxV: 25, lane: 7, name: 'Racer' },
  { key: 'cruiser', kind: 'board', edge: 0.45, pull: 0, across: 62, maxV: 13, lane: 12, name: 'Cruiser' },
  { key: 'skier', kind: 'ski', edge: 0.55, pull: 0, across: 55, maxV: 15, lane: 10, name: 'Skier' },
  { key: 'beginner', kind: 'board', edge: 0.32, pull: 0.4, across: 80, maxV: 7, lane: 8, name: 'Beginner' },
  { key: 'family', kind: 'ski', edge: 0.4, pull: 0.25, across: 75, maxV: 9, lane: 10, name: 'Skier' },
  { key: 'freerider', kind: 'board', edge: 0.6, pull: 0, across: 45, maxV: 21, lane: 16, name: 'Freerider' },
];

class Bot {
  constructor(scene, i) {
    this.style = STYLES[i % STYLES.length];
    const outfit = OUTFITS[(i + 1) % OUTFITS.length];
    this.model = this.style.kind === 'ski' ? createSkierModel({ outfit, lod: true }) : createRiderModel({ outfit, lod: true });
    scene.add(this.model.root);
    this.rider = new Rider(terrain);
    this.vis = newVis();
    this.tracks = new Tracks(scene, 0.3);
    this.input = { steer: 0, pull: 0 };
    this.dir = Math.random() < 0.5 ? 1 : -1;
    this.laneOff = (Math.random() * 2 - 1) * this.style.lane;
    this.takeBranch = Math.random() < 0.45;
    this.acc = 0;
    this.steerS = 0;
  }
  spawn(z, playerX) {
    const r = this.rider;
    r.reset(Math.max(6, z));
    let x = pisteCenter(r.p[2]) + this.laneOff;
    const b = activeBranch(r.p[2]);
    if (b && this.takeBranch) x = branchCenter(b, r.p[2]) + this.laneOff * 0.6;
    if (Math.abs(x - playerX) < 3) x += 6;
    r.p[0] = x; r.p[1] = terrain.height(x, r.p[2]);
    r._frame();
    r.yaw = r.fallLineYaw() + this.dir * 0.5;
    r._frame();
    const v0 = 4 + Math.random() * this.style.maxV * 0.6;
    r.v = [r.f[0] * v0, r.f[1] * v0, r.f[2] * v0];
    this.tracks.clear();
    this.vis = newVis();
  }
  think(dt, player) {
    const r = this.rider, S = this.style;
    const z = r.p[2];
    // terrain park: line up on a jump line and ride it straight; freeriders spin
    if (parkAt(z) && Math.abs(r.p[0] - pisteCenter(z)) < PARK_HALF + 4) {
      const line = S.maxV > 15 ? -6 : 6;
      if (!r.grounded) {
        if (S.key === 'freerider' && this.spinLeft === undefined) this.spinLeft = Math.PI * (Math.random() < 0.5 ? 1 : 2);
        if (this.spinLeft > 0) { const before = r.yaw; this.input.steer = 1; this.spinLeft -= Math.abs(r.yaw - (this.lastYaw ?? r.yaw)); this.lastYaw = r.yaw; this.input.pull = 0; return; }
        const agl = r.p[1] - terrain.height(r.p[0], r.p[2]);
        this.input.steer = 0; this.input.pull = S.key === 'carver' && (r.v[1] > 0 || agl > 1.3) ? 0.6 : 0; // carvers grab, let go before landing
        return;
      }
      this.spinLeft = undefined; this.lastYaw = undefined;
      const aim = pisteCenter(z + 12) + line;
      const head = Math.atan2(r.v[0], r.v[2]), want = Math.atan2(aim - r.p[0], 12);
      this.steerS = clamp(-(want - head) * 2.5, -0.35, 0.35);
      this.input.steer = this.steerS;
      this.input.pull = r.tel.speed > (line < 0 ? 17 : 13) ? 0.25 : -0.5;
      return;
    }
    let lane = pisteCenter(z) + this.laneOff;
    const b = activeBranch(z);
    if (b && this.takeBranch) lane = branchCenter(b, z) + this.laneOff * 0.6;
    const a = wrap(r.yaw - r.fallLineYaw()) * r.travel; // + heading toward +x
    const sp = r.tel.speed;
    // wider turns when too fast
    const across = (S.across + Math.max(0, sp - S.maxV) * 6) * D2R;
    if (this.dir > 0 && a < -across) this.dir = -1;
    if (this.dir < 0 && a > across) this.dir = 1;
    const dx = r.p[0] - lane;
    if (dx > 4 && a > 0.15) this.dir = 1;      // drifting right of the lane: turn back
    if (dx < -4 && a < -0.15) this.dir = -1;
    // obstacles: look ahead along the velocity
    const look = Math.min(24, 3 + sp * 1.5);
    const vl = Math.hypot(r.v[0], r.v[2]) || 1;
    const lx = r.p[0] + r.v[0] / vl * look, lz = r.p[2] + r.v[2] / vl * look;
    const hit = terrain.treeHit(lx, lz, 1.6);
    let danger = false;
    if (hit) { this.dir = hit.x > r.p[0] ? 1 : -1; danger = true; } // turn away from it (right turn = toward -x)
    // drifting off the piste toward the trees: head back to the lane
    if (Math.abs(dx) > 16) { this.dir = dx > 0 ? 1 : -1; danger = true; }
    // keep clear of the player
    const px = player.p[0] - r.p[0], pz = player.p[2] - r.p[2];
    const pd = Math.hypot(px, pz);
    if (pd < 7 && (px * r.v[0] + pz * r.v[2]) > 0) this.dir = px > 0 ? 1 : -1;
    // a kicker coming up: straighten out, no skidding into the lip
    const kk = Math.round((z + 15 - 150) / KICK_SPACING);
    if (kk >= 0) {
      const K = kickerAt(kk);
      if (K.kz - z > -4 && K.kz - z < 32 && Math.abs(r.p[0] - K.kx) < 9 && !parkAt(K.kz)) {
        this.steerS += clamp(0 - this.steerS, -3 * dt, 3 * dt);
        this.input.steer = r.grounded ? this.steerS : 0; this.input.pull = 0;
        return;
      }
    }
    if (!r.grounded) { this.input.steer = 0; this.input.pull = 0; return; }
    let pull = S.pull;
    // speed control: scrub speed with a skid when going too fast (like real riders do)
    if (sp > S.maxV) pull = Math.max(pull, clamp((sp - S.maxV) / 5, 0.15, 0.8));
    if (danger && sp > 8) pull = Math.max(pull, 0.5);
    const target = this.dir * S.edge * (r.crashT > 0 ? 0 : 1);
    this.steerS += clamp(target - this.steerS, -2.6 * dt, 2.6 * dt);
    this.input.steer = this.steerS;
    this.input.pull = pull * (Math.abs(this.steerS) > 0.2 ? 1 : 0.5);
    if (this.input.pull > 0.2) this.input.steer = clamp(this.input.steer, -0.5, 0.5); // brake, don't spin
  }
}

export class Crowd {
  constructor(scene, n = 7) {
    this.bots = [];
    for (let i = 0; i < n; i++) this.bots.push(new Bot(scene, i));
    this.scene = scene;
    this.started = false;
  }
  place(player) {
    this.bots.forEach((b, i) => b.spawn(player.p[2] + 25 + i * 28 + Math.random() * 15, player.p[0]));
    this.started = true;
  }
  update(dt, player, fx, onHit) {
    if (!this.started) this.place(player);
    for (const b of this.bots) {
      const r = b.rider;
      const dz = r.p[2] - player.p[2];
      if (dz < -110 || dz > 300 || Math.abs(r.p[0] - player.p[0]) > 150) {
        const ahead = Math.random() < 0.75;
        b.spawn(player.p[2] + (ahead ? 170 + Math.random() * 90 : -(60 + Math.random() * 40)), player.p[0]);
        continue;
      }
      b.think(dt, player);
      b.acc += dt;
      while (b.acc >= 1 / 60) { r.step(1 / 60, b.input); b.acc -= 1 / 60; }
      const dist = Math.hypot(r.p[0] - player.p[0], r.p[2] - player.p[2]);
      const visible = dist < 180;
      b.model.root.visible = visible;
      if (visible) animateRider(b.model, r, b.vis, b.input, dt);
      if (dist < 130) {
        b.tracks.update(r, dt);
        fx.powder.fromRider(r, r.mode.key, dt, 0.6);
        fx.spray.fromRider(r, r.mode.key, dt, 0.5);
      }
      // collisions with the player
      const dy = r.p[1] - player.p[1];
      const d3 = Math.hypot(dist, dy);
      if (d3 < 0.95 && r.crashT <= 0 && player.crashT <= 0) {
        const rv = Math.hypot(r.v[0] - player.v[0], r.v[2] - player.v[2]);
        if (rv > 4) { player.crash('撞到人了'); r.crash('collision'); onHit && onHit(); }
        else {
          const nx = (player.p[0] - r.p[0]) / (dist || 1), nz = (player.p[2] - r.p[2]) / (dist || 1);
          player.p[0] += nx * 0.25; player.p[2] += nz * 0.25; r.p[0] -= nx * 0.25; r.p[2] -= nz * 0.25;
        }
      }
    }
  }
  reset(player) { this.place(player); }
}
