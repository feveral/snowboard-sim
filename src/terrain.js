// Procedural mountain: downhill is +Z, up is +Y.
import { noise2, fbm, hash2, smoothstep } from './noise.js';

const D2R = Math.PI / 180;
export const TREE_CELL = 6;

// Piste centre line wanders left/right as you go down
export function pisteCenter(z) {
  return 38 * Math.sin(z / 190) + 16 * Math.sin(z / 71 + 1.3);
}

// Integral of slope: tan(slope) = 0.34 + 0.10 sin(z/180) + 0.05 sin(z/57)
// -> pitch varies roughly 12°–26°. Gentle run-in for the first ~25 m.
function drop(z) {
  const d = 0.34 * z - 18 * Math.cos(z / 180) - 2.85 * Math.cos(z / 57) + 20.85;
  const runIn = z < 25 ? (25 - z) * (25 - z) * 0.0045 : 0;
  return d + runIn;
}

export function height(x, z) {
  const c = pisteCenter(z);
  const dx = x - c;
  let h = -drop(z);
  // valley: sides rise away from piste (saturating)
  const q = dx / 60;
  h += 9 * (q * q) / (1 + Math.abs(q) * 0.35);
  // large undulation
  h += 4.5 * fbm(x * 0.017 + 5.1, z * 0.017, 3);
  // rollers across the slope (some big enough to pop you off at speed)
  const rollAmp = Math.max(0, 0.55 + 0.9 * noise2(z * 0.006, 3.7));
  h += 1.9 * rollAmp * Math.sin(z * 0.082 + 0.7 * noise2(x * 0.02, z * 0.01));
  // small surface texture; off-piste gets mogul-like bumps
  const off = smoothstep(14, 30, Math.abs(dx));
  h += (0.10 + 0.6 * off) * fbm(x * 0.12, z * 0.12, 2);
  h += kicker(x, z);
  return h;
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
  const dx = Math.abs(x - pisteCenter(z));
  const off = smoothstep(16, 30, dx);
  const iceN = noise2(x * 0.035 + 40, z * 0.03);
  const ice = off < 0.5 && iceN > 0.38 ? smoothstep(0.38, 0.5, iceN) : 0;
  const phi = (11 - 8 * ice + 4 * off) * D2R;
  const mu = 0.045 - 0.015 * ice + 0.06 * off;
  return { phi, mu, ice, off };
}

// Trees, deterministic per 6 m cell
export function treeInCell(i, j) {
  const cx = (i + 0.5) * TREE_CELL, cz = (j + 0.5) * TREE_CELL;
  if (cz < -40) return null;
  const dx = Math.abs(cx - pisteCenter(cz));
  let dens = 0.006 + 0.62 * smoothstep(17, 36, dx);
  dens *= 0.45 + 0.9 * Math.max(0, noise2(cx / 70, cz / 70) + 0.45);
  if (cz < 30 && dx < 30) dens = 0;
  // keep kicker run-ins and landings clear
  const kk = Math.round((cz - 150) / KICK_SPACING);
  if (kk >= 0) {
    const kc = kickerAt(kk);
    if (cz > kc.kz - 30 && cz < kc.kz + 45 && Math.abs(cx - kc.kx) < 14) dens = 0;
  }
  const h = hash2(i, j);
  if (h >= dens) return null;
  const x = cx + (hash2(i + 71, j) - 0.5) * TREE_CELL * 0.8;
  const z = cz + (hash2(i, j + 53) - 0.5) * TREE_CELL * 0.8;
  const s = 0.65 + hash2(i + 7, j + 3) * 0.85;
  return { x, z, s, r: 0.35 + 0.25 * s };
}

export function treesInRect(x0, x1, z0, z1, cb) {
  const i0 = Math.floor(x0 / TREE_CELL), i1 = Math.floor(x1 / TREE_CELL);
  const j0 = Math.floor(z0 / TREE_CELL), j1 = Math.floor(z1 / TREE_CELL);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const t = treeInCell(i, j);
      if (t) cb(t);
    }
}

// returns the tree hit within radius rr of (x,z), else null
export function treeHit(x, z, rr) {
  let hit = null;
  treesInRect(x - 6, x + 6, z - 6, z + 6, (t) => {
    const d = Math.hypot(x - t.x, z - t.z);
    if (d < t.r + rr && (!hit || d < hit.d)) hit = { ...t, d };
  });
  return hit;
}

export const terrain = { height, normal, surface, treeHit, pisteCenter };
