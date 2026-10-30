// Procedural mountain: downhill is +Z, up is +Y.
import { noise2, fbm, hash2, smoothstep } from './noise.js';

const D2R = Math.PI / 180;
export const TREE_CELL = 6;

// ---------------------------------------------------------------- piste network
// Main run wanders left/right as you go down
export function pisteCenter(z) {
  return 38 * Math.sin(z / 190) + 16 * Math.sin(z / 71 + 1.3);
}

// Side runs split off the main run and merge back further down.
export const BRANCH_PERIOD = 640;
export const BRANCH_TYPES = [
  { key: 'mogul', name: '蘑菇坡 黑線', en: 'MOGUL RUN', color: '#111' },
  { key: 'trees', name: '林間道 藍線', en: 'TREE RUN', color: '#1f5fd6' },
  { key: 'steep', name: '陡坡 黑線', en: 'THE WALL', color: '#111' },
];
export function branchAt(k) {
  if (k < 0) return null;
  const zs = 360 + k * BRANCH_PERIOD, ze = zs + 440;
  return { k, zs, ze, side: 1, D: 74, type: BRANCH_TYPES[k % 3] };
}
function branchOffset(b, z) {
  const t = (z - b.zs) / (b.ze - b.zs);
  if (t <= 0 || t >= 1) return 0;
  return smoothstep(0, 0.28, t) * (1 - smoothstep(0.72, 1, t));
}
export function branchCenter(b, z) {
  const s = branchOffset(b, z);
  return pisteCenter(z) + b.side * (b.D * s + 9 * Math.sin(z / 37) * s);
}
export function activeBranch(z) {
  const k = Math.floor((z - 360) / BRANCH_PERIOD);
  const b = branchAt(k);
  if (!b || z <= b.zs || z >= b.ze) return null;
  return b;
}
// distance to the nearest piste centre line + which one
export function pisteInfo(x, z) {
  const dm = Math.abs(x - pisteCenter(z));
  const b = activeBranch(z);
  if (b) {
    const db = Math.abs(x - branchCenter(b, z));
    if (db < dm) return { d: db, branch: b, w: branchOffset(b, z) };
  }
  return { d: dm, branch: null, w: 0 };
}
export function pisteDist(x, z) { return pisteInfo(x, z).d; }

// ---------------------------------------------------------------- shape of the mountain
// Integral of slope: tan(slope) = 0.34 + 0.10 sin(z/180) + 0.05 sin(z/57)
// plus a short steep "wall" every 700 m. Gentle run-in for the first ~25 m.
const WALL_P = 700, WALL_LEN = 90, WALL_A = 0.16, WALL_K = 0.12;
const softplus = (x) => (x > 30 ? x : Math.log1p(Math.exp(x)));
function drop(z) {
  let d = 0.34 * z - 18 * Math.cos(z / 180) - 2.85 * Math.cos(z / 57) + 20.85;
  const runIn = z < 25 ? (25 - z) * (25 - z) * 0.0045 : 0;
  if (z > 0) {
    const w = Math.floor(z / WALL_P);
    const z1 = w * WALL_P + 430, z2 = z1 + WALL_LEN;
    d += WALL_A * WALL_LEN * w;
    d += WALL_A * (softplus(WALL_K * (z - z1)) - softplus(WALL_K * (z - z2))) / WALL_K;
  }
  return d + runIn;
}

export function height(x, z) {
  const pi = pisteInfo(x, z);
  const dx = pi.d;
  let base = -drop(z);
  // valley: sides rise away from the nearest piste (saturating); width breathes
  const W = 58 + 18 * Math.sin(z / 260 + 1.1);
  const q = dx / W;
  base += 9.5 * (q * q) / (1 + q * 0.35) - Math.max(0, dx - 160) * 0.12; // far side slopes level out a bit
  const pm = parkMask(x, z);
  if (pm >= 1) return base + parkFeatures(x, z);
  let h = 0;
  // large undulation
  h += 4.5 * fbm(x * 0.017 + 5.1, z * 0.017, 3);
  // rollers across the slope (some big enough to pop you off at speed)
  const rollAmp = Math.max(0, 0.55 + 0.9 * noise2(z * 0.006, 3.7));
  h += 1.9 * rollAmp * Math.sin(z * 0.082 + 0.7 * noise2(x * 0.02, z * 0.01));
  // small surface texture; off-piste gets lumpy
  const off = smoothstep(14, 30, dx);
  h += (0.10 + 0.6 * off) * fbm(x * 0.12, z * 0.12, 2);
  // moguls on the mogul run
  if (pi.branch && pi.branch.type.key === 'mogul' && pi.w > 0.6) {
    const m = (1 - smoothstep(9, 15, dx)) * smoothstep(0.6, 0.9, pi.w);
    const u = x * 0.62 + z * 0.33, v = z * 0.58 - x * 0.31;
    h += m * 0.75 * Math.sin(u) * Math.sin(v);
  }
  h += kicker(x, z);
  if (pm <= 0) return base + h;
  return base + h * (1 - pm) + pm * parkFeatures(x, z);
}

// ---------------------------------------------------------------- terrain park
// A groomed park on the main run every 2.1 km: two jump lines (small / big tabletops),
// ride-on boxes and a set of rollers. Features follow the piste centre line.
export const PARK_PERIOD = 2100, PARK_START = 560, PARK_LEN = 340;
export const PARK_HALF = 17;
export const PARK_FEATURES = [
  { type: 'jump', off: 6, u: 40, H: 1.0, T: 4, name: 'S' },
  { type: 'jump', off: -6, u: 52, H: 1.9, T: 8, name: 'M' },
  { type: 'jump', off: 6, u: 108, H: 1.4, T: 6, name: 'S' },
  { type: 'jump', off: -6, u: 128, H: 2.6, T: 11, name: 'L' },
  { type: 'jump', off: 6, u: 178, H: 1.8, T: 7, name: 'M' },
  { type: 'jump', off: -6, u: 212, H: 3.2, T: 14, name: 'XL' },
  { type: 'box', off: 5, u: 272, len: 7, h: 0.55, name: 'Box' },
  { type: 'box', off: -5, u: 278, len: 10, h: 0.6, name: 'Long Box' },
  { type: 'rollers', off: 0, u: 300, len: 36 },
];
for (const f of PARK_FEATURES) if (f.type === 'jump') { f.Lt = 3.3 * f.H; f.Ll = 6.5 * f.H; f.W = 6.5; }
export function parkAt(z) {
  const k = Math.floor((z - PARK_START + 60) / PARK_PERIOD);
  if (k < 0) return null;
  const z0 = PARK_START + k * PARK_PERIOD;
  if (z < z0 - 45 || z > z0 + PARK_LEN + 45) return null;
  return { k, z0 };
}
export function parkMask(x, z) {
  const P = parkAt(z);
  if (!P) return 0;
  const u = z - P.z0;
  const along = smoothstep(-40, -12, u) * (1 - smoothstep(PARK_LEN + 12, PARK_LEN + 40, u));
  const across = 1 - smoothstep(PARK_HALF + 1, PARK_HALF + 9, Math.abs(x - pisteCenter(z)));
  return along * across;
}
function jumpProfile(f, u) {
  // takeoff (parabola, lip ~30°) -> flat table -> knuckle + landing (smoothstep down)
  if (u <= 0) return 0;
  if (u < f.Lt) { const t = u / f.Lt; return f.H * t * t; }
  if (u < f.Lt + f.T) return f.H;
  const t = (u - f.Lt - f.T) / f.Ll;
  if (t >= 1) return 0;
  return f.H * (1 - t * t * (3 - 2 * t));
}
export function parkFeatures(x, z) {
  const P = parkAt(z);
  if (!P) return 0;
  const u = z - P.z0, dx = x - pisteCenter(z);
  let h = 0;
  for (const f of PARK_FEATURES) {
    const lu = u - f.u;
    if (f.type === 'jump') {
      if (lu < 0 || lu > f.Lt + f.T + f.Ll) continue;
      const side = 1 - smoothstep(f.W / 2 - 0.5, f.W / 2 + 1.8, Math.abs(dx - f.off));
      if (side > 0) h += jumpProfile(f, lu) * side;
    } else if (f.type === 'box') {
      if (lu < 0 || lu > f.len) continue;
      const side = 1 - smoothstep(0.42, 0.6, Math.abs(dx - f.off));
      if (side > 0) h += f.h * smoothstep(0, 1.4, lu) * side;
    } else if (f.type === 'rollers') {
      if (lu < 0 || lu > f.len) continue;
      const env = smoothstep(0, 4, lu) * (1 - smoothstep(f.len - 4, f.len, lu));
      h += 0.75 * env * (0.5 - 0.5 * Math.cos(lu / 9 * Math.PI * 2));
    }
  }
  return h;
}
// which box (if any) the point is on
export function boxAt(x, z) {
  const P = parkAt(z);
  if (!P) return null;
  const u = z - P.z0, dx = x - pisteCenter(z);
  for (const f of PARK_FEATURES) {
    if (f.type !== 'box') continue;
    const lu = u - f.u;
    if (lu > 1.0 && lu < f.len && Math.abs(dx - f.off) < 0.45) return f;
  }
  return null;
}

// Natural kickers / drop-offs on the piste every ~140 m
export const KICK_SPACING = 140;
export function kickerAt(k) {
  const kz = 150 + k * KICK_SPACING;
  const kx = pisteCenter(kz) + 11 * Math.sin(k * 1.9 + 0.4);
  const hgt = 1.2 + 0.6 * ((k * 0.618) % 1);
  return { kx, kz, hgt };
}
function kicker(x, z) {
  const k = Math.round((z - 150) / KICK_SPACING);
  if (k < 0) return 0;
  if (parkAt(150 + k * KICK_SPACING)) return 0;
  const { kx, kz, hgt } = kickerAt(k);
  const u = z - kz;
  if (u < -9 || u > 3.5) return 0;
  const lat = 1 - smoothstep(4, 7, Math.abs(x - kx));
  if (lat <= 0) return 0;
  let prof;
  if (u <= 0) { const t = (u + 9) / 9; prof = t * t * (1.6 - 0.6 * t); }
  else prof = 1 - smoothstep(0, 3.5, u);
  return hgt * prof * lat;
}

export function normal(x, z, out = [0, 1, 0]) {
  const e = 0.35;
  const hx = (height(x + e, z) - height(x - e, z)) / (2 * e);
  const hz = (height(x, z + e) - height(x, z - e)) / (2 * e);
  const l = Math.hypot(hx, 1, hz);
  out[0] = -hx / l; out[1] = 1 / l; out[2] = -hz / l;
  return out;
}

// Snow surface properties.
// phi: "edge-hold" friction angle; mu: base glide friction.
export function surface(x, z) {
  const dx = pisteDist(x, z);
  const off = smoothstep(16, 30, dx);
  const iceN = noise2(x * 0.035 + 40, z * 0.03);
  const ice = off < 0.5 && iceN > 0.38 ? smoothstep(0.38, 0.5, iceN) : 0;
  const pm = parkMask(x, z);
  if (pm > 0.5) {
    const box = boxAt(x, z);
    if (box) return { phi: 2 * D2R, mu: 0.02, ice: 0, off: 0, box };
    return { phi: 12 * D2R, mu: 0.04, ice: 0, off: 0, park: true };
  }
  const phi = (11 - 8 * ice + 4 * off) * D2R;
  const mu = 0.045 - 0.015 * ice + 0.06 * off;
  return { phi, mu, ice, off };
}

// ---------------------------------------------------------------- features
// Chairlift runs along the side of the piste
export const LIFT_OFFSET = -46;
export function liftX(z) { return pisteCenter(z) + LIFT_OFFSET; }
export const LIFT_TOWER_SPACING = 64;

// Mountain huts beside the main run
export const LODGE_SPACING = 900;
export function lodgeNear(z) {
  const k = Math.round((z - 520) / LODGE_SPACING);
  if (k < 0) return null;
  const lz = 520 + k * LODGE_SPACING;
  return { k, x: pisteCenter(lz) - 31, z: lz };
}

// Slalom gates on the piste (skipped around kickers)
export const GATE_SPACING = 27;
export const GATE_HALF = 2.1; // half-width of the opening
export function gateAt(k) {
  if (k < 0) return null;
  const z = 64 + k * GATE_SPACING;
  const kk = Math.round((z - 150) / KICK_SPACING);
  if (kk >= 0) {
    const kc = kickerAt(kk);
    if (z > kc.kz - 34 && z < kc.kz + 40) return null;
  }
  if (parkAt(z)) return null;
  const side = k % 2 ? 1 : -1;
  const x = pisteCenter(z) + side * (5 + 1.5 * hash2(k, 991));
  return { k, x, z, side, color: k % 2 ? 'red' : 'blue' };
}
export function gatesInRange(z0, z1, cb) {
  const k0 = Math.max(0, Math.floor((z0 - 64) / GATE_SPACING)), k1 = Math.ceil((z1 - 64) / GATE_SPACING);
  for (let k = k0; k <= k1; k++) { const g = gateAt(k); if (g) cb(g); }
}

function clearZone(cx, cz) {
  if (parkAt(cz) && Math.abs(cx - pisteCenter(cz)) < PARK_HALF + 8) return true;
  if (cz < 30 && Math.abs(cx - pisteCenter(cz)) < 30) return true;
  const kk = Math.round((cz - 150) / KICK_SPACING);
  if (kk >= 0) {
    const kc = kickerAt(kk);
    if (cz > kc.kz - 30 && cz < kc.kz + 45 && Math.abs(cx - kc.kx) < 14) return true;
  }
  if (Math.abs(cx - liftX(cz)) < 7.5) return true;
  const L = lodgeNear(cz);
  if (L && Math.abs(cx - L.x) < 13 && Math.abs(cz - L.z) < 11) return true;
  const b = branchAt(Math.floor((cz - 360) / BRANCH_PERIOD));
  if (b && Math.abs(cz - (b.zs + 25)) < 8 && Math.abs(cx - (pisteCenter(b.zs + 25) + 15)) < 4) return true;
  return false;
}

// Trees, deterministic per 6 m cell
export function treeInCell(i, j) {
  const cx = (i + 0.5) * TREE_CELL, cz = (j + 0.5) * TREE_CELL;
  if (cz < -60) return null;
  const dx = pisteDist(cx, cz);
  let dens = 0.005 + 0.64 * smoothstep(17, 36, dx);
  dens *= 0.45 + 0.9 * Math.max(0, noise2(cx / 70, cz / 70) + 0.45);
  const h = hash2(i, j);
  if (h >= dens) return null;
  const x = cx + (hash2(i + 71, j) - 0.5) * TREE_CELL * 0.8;
  const z = cz + (hash2(i, j + 53) - 0.5) * TREE_CELL * 0.8;
  if (clearZone(x, z)) return null;
  const s = 0.6 + hash2(i + 7, j + 3) * 0.9;
  const kind = hash2(i + 13, j + 29);
  return { x, z, s, kind, r: 0.35 + 0.25 * s, type: 'tree' };
}

// Rocks poke out of the off-piste
export const ROCK_CELL = 11;
export function rockInCell(i, j) {
  const cx = (i + 0.5) * ROCK_CELL, cz = (j + 0.5) * ROCK_CELL;
  const dx = pisteDist(cx, cz);
  const dens = 0.16 * smoothstep(21, 34, dx);
  if (hash2(i + 401, j + 77) >= dens) return null;
  const x = cx + (hash2(i + 3, j + 501) - 0.5) * ROCK_CELL * 0.7;
  const z = cz + (hash2(i + 211, j + 9) - 0.5) * ROCK_CELL * 0.7;
  if (clearZone(x, z)) return null;
  const s = 0.6 + hash2(i + 17, j + 61) * 1.7;
  return { x, z, s, rot: hash2(i, j + 7) * 6.28, r: 0.55 * s, type: 'rock' };
}

function cellsIn(cell, fn, x0, x1, z0, z1, cb) {
  const i0 = Math.floor(x0 / cell), i1 = Math.floor(x1 / cell);
  const j0 = Math.floor(z0 / cell), j1 = Math.floor(z1 / cell);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const t = fn(i, j);
      if (t) cb(t);
    }
}
export function treesInRect(x0, x1, z0, z1, cb) { cellsIn(TREE_CELL, treeInCell, x0, x1, z0, z1, cb); }
export function rocksInRect(x0, x1, z0, z1, cb) { cellsIn(ROCK_CELL, rockInCell, x0, x1, z0, z1, cb); }

// nearest obstacle (tree or rock) within radius rr of (x,z), else null
export function treeHit(x, z, rr) {
  let hit = null;
  const test = (t) => {
    const d = Math.hypot(x - t.x, z - t.z);
    if (d < t.r + rr && (!hit || d < hit.d)) hit = { ...t, d };
  };
  treesInRect(x - 6, x + 6, z - 6, z + 6, test);
  rocksInRect(x - 12, x + 12, z - 12, z + 12, test);
  // lift towers
  const k = Math.round(z / LIFT_TOWER_SPACING);
  const tz = k * LIFT_TOWER_SPACING, tx = liftX(tz);
  test({ x: tx, z: tz, r: 0.45, type: 'tower' });
  const L = lodgeNear(z);
  if (L) {
    const lx = Math.abs(x - L.x), lz = Math.abs(z - L.z);
    if (lx < 5.2 + rr && lz < 4.2 + rr) hit = { ...L, d: 0, r: 0, type: 'lodge' };
  }
  return hit;
}

export const terrain = { height, normal, surface, treeHit, pisteCenter };

// rough share of ground covered by forest (for far-away rendering)
export function forestDensity(x, z) {
  const dx = pisteDist(x, z);
  let dens = 0.005 + 0.64 * smoothstep(17, 36, dx);
  dens *= 0.45 + 0.9 * Math.max(0, noise2(x / 70, z / 70) + 0.45);
  return Math.min(1, dens * 1.25);
}
