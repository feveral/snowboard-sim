// Headless play-test: scripted riders, prints what the physics does.
import { Rider } from '../src/physics.js';
import { terrain } from '../src/terrain.js';

const DT = 1 / 120;
const D = 180 / Math.PI;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function run(name, secs, bot, z0) {
  const r = new Rider(terrain);
  if (z0) r.reset(z0);
  const modes = {};
  const crashes = [];
  let t = 0, lastCrash = 0;
  const samples = [];
  const st = {};
  while (t < secs) {
    const inp = bot(r, t, st);
    r.step(DT, inp);
    t += DT;
    modes[r.mode.key] = (modes[r.mode.key] || 0) + DT;
    if (r.stats.crashes > lastCrash) { lastCrash = r.stats.crashes; crashes.push(`${t.toFixed(1)}s ${r.crashReason} v=${(r.tel.speed * 3.6).toFixed(0)}`); }
    if (Math.abs((t % 1)) < DT && t > 0.5) samples.push(r);
    if (st.log && Math.round(t * 120) % Math.round(120 * st.log) === 0) {
      const tl = r.tel;
      console.log(`  t=${t.toFixed(1)} v=${(tl.speed * 3.6).toFixed(0)}km/h edge=${(r.edge * D).toFixed(0)} β=${(tl.betaS * D).toFixed(1)} latG=${tl.latG.toFixed(2)} R=${isFinite(tl.radius) ? tl.radius.toFixed(1) : '∞'} grip=${tl.grip} ${r.mode.key} z=${r.p[2].toFixed(0)}`);
    }
  }
  const tot = Object.values(modes).reduce((a, b) => a + b, 0);
  console.log(`\n== ${name} ==`);
  console.log('  modes:', Object.entries(modes).map(([k, v]) => `${k} ${(100 * v / tot).toFixed(0)}%`).join(', '));
  console.log(`  maxSpeed ${(r.stats.maxSpeed * 3.6).toFixed(0)} km/h, maxG ${r.stats.maxG.toFixed(2)}, dist ${r.stats.dist.toFixed(0)} m, maxAir ${r.stats.maxAir.toFixed(2)}s, carve% ${(100 * r.stats.carveDist / (r.stats.turnDist || 1)).toFixed(0)}`);
  console.log('  crashes:', crashes.length ? crashes.join(' | ') : 'none');
  return r;
}

const rel = (r) => wrap(r.yaw - r.fallLineYaw()); // + = heading to the left of fall line

// 1. Straight-line bomb down the fall line (steer keeps nose downhill, flat base)
run('straight run', 40, (r) => ({ steer: Math.max(-0.3, Math.min(0.3, rel(r) * 0.8)), pull: -1 }));

// 2. Carving S-turns: roll onto edge and HOLD, switch when the turn is finished
function turner(edge, pull, across = 55 / D, log = 0) {
  return (r, t, st) => {
    if (st.dir === undefined) { st.dir = 1; st.log = log; }
    const a = rel(r);
    // turning right (dir=+1) makes yaw decrease -> a goes negative
    if (st.dir > 0 && a < -across) st.dir = -1;
    if (st.dir < 0 && a > across) st.dir = 1;
    return { steer: st.dir * edge, pull };
  };
}
run('carve S-turns edge 0.55', 60, turner(0.55, 0));
run('carve S-turns edge 0.8 (aggressive)', 60, turner(0.8, 0));
run('skidded turns (edge 0.35 + pivot 0.6)', 60, turner(0.35, 0.6));
run('low-edge steering (edge 0.2)', 60, turner(0.2, 0));
// 3. Slow thumb transitions: edge ramps slowly between sides (catch-edge risk)
run('slow edge change', 60, (r, t, st) => {
  if (st.dir === undefined) st.dir = 1, st.e = 0;
  const a = rel(r);
  if (st.dir > 0 && a < -50 / D) st.dir = -1;
  if (st.dir < 0 && a > 50 / D) st.dir = 1;
  st.e += Math.sign(st.dir * 0.6 - st.e) * Math.min(Math.abs(st.dir * 0.6 - st.e), 1.0 * DT);
  return { steer: st.e, pull: 0 };
});
// 4. Hockey stop: get speed, then pivot hard
run('speed then hockey stop', 14, (r, t) => t < 8 ? { steer: Math.max(-0.3, Math.min(0.3, rel(r) * 0.8)), pull: -1 } : { steer: -0.3, pull: 1 });
// 5. Side slip: board across the hill, small uphill edge
run('side-slip', 10, (r, t, st) => {
  st.log = 1;
  // keep board across: heading 90° from fall line. small heelside (toward uphill)
  r.yaw = r.fallLineYaw() + Math.PI / 2;
  return { steer: t < 5 ? -0.08 : -0.3, pull: 0 };
}, 200);
// 6. Escape a side-slip: board across the hill at speed, then hold steer one way
for (const sgn of [1, -1]) run(`sideways escape, hold ${sgn > 0 ? 'right' : 'left'}`, 8, (r, t, st) => {
  if (!st.init) { st.init = 1; r.yaw = r.fallLineYaw() + Math.PI / 2; r._frame(); const n = r.n; r.v = [n[0] * 8, 0, n[2] * 8]; }
  if (st.log === undefined) st.log = 1;
  return { steer: sgn * 0.7, pull: 0 };
}, 260);
// 7. Long session with crashes: random human-ish rider, measure how long it stays stuck sideways
run('3-min random rider', 180, (r, t, st) => {
  if (st.next === undefined) { st.next = 0; st.s = 0; st.p = 0; st.side = 0; }
  if (t > st.next) { st.next = t + 0.8 + Math.random() * 2.2; st.s = (Math.random() * 2 - 1); st.p = Math.random() < 0.2 ? Math.random() : (Math.random() < 0.2 ? -1 : 0); }
  if (r.mode.key === 'scrape') st.side += 1 / 120;
  if (Math.abs(t - 179.99) < 0.01) console.log('  time in scrape:', st.side.toFixed(1), 's');
  return { steer: st.s, pull: st.p };
});
// 8. Heelside / toeside side-slip then release -> should end up riding straight again
for (const dir of [1, -1]) run(`brake ${dir > 0 ? 'right(toe)' : 'left(heel)'} 3s, release`, 9, (r, t, st) => {
  st.log = 1;
  if (t < 3) return { steer: 0, pull: -1 };
  if (t < 6) return { steer: dir * 0.3, pull: 1 };
  return { steer: 0, pull: 0 };
}, 300);
