// Park play-test: ride each jump line straight at different entry speeds.
import { Rider } from '../src/physics.js';
import { terrain, pisteCenter, PARK_START } from '../src/terrain.js';
const DT = 1 / 120;
function ride(off, v0, ollieAtLip = false, spin = 0) {
  const r = new Rider(terrain);
  const z = PARK_START + 10;
  r.reset(z); r.p[0] = pisteCenter(z) + off; r.p[1] = terrain.height(r.p[0], z);
  r._frame(); r.yaw = Math.atan2(pisteCenter(z + 1) - pisteCenter(z), 1); r._frame();
  r.v = [r.f[0] * v0, r.f[1] * v0, r.f[2] * v0];
  const jumps = []; let air = 0, maxH = 0, spun = 0, y0;
  for (let t = 0; t < 40 && r.p[2] < PARK_START + 270; t += DT) {
    const aim = pisteCenter(r.p[2] + 12) + off;
    const head = Math.atan2(r.v[0], r.v[2]), want = Math.atan2(aim - r.p[0], 12);
    let steer = r.grounded ? Math.max(-0.35, Math.min(0.35, -(want - head) * 2.5)) : 0;
    if (!r.grounded && spin && spun < spin) { steer = 1; }
    const inp = { steer, pull: 0, ollie: false };
    const wasG = r.grounded, yaw0 = r.yaw;
    r.step(DT, inp);
    if (!r.grounded) { air += DT; maxH = Math.max(maxH, r.p[1] - terrain.height(r.p[0], r.p[2])); spun += Math.abs(r.yaw - yaw0); }
    if (r.grounded && !wasG && air > 0.15) { jumps.push(`${air.toFixed(2)}s h${maxH.toFixed(1)} land${r.tel.landed.toFixed(1)}${r.crashT > 0 ? ' CRASH:' + r.crashReason : ''}`); air = 0; maxH = 0; spun = 0; }
    if (r.crashT > 0 && r.crashT > 1.7 && !jumps.at(-1)?.includes('CRASH')) jumps.push('CRASH ' + r.crashReason + ' z=' + (r.p[2] - PARK_START).toFixed(0));
  }
  return jumps.join(' | ');
}
for (const v of [8, 11, 14, 17]) console.log(`small line  ${v * 3.6 | 0}km/h:`, ride(6, v));
for (const v of [10, 13, 16, 19]) console.log(`big line    ${v * 3.6 | 0}km/h:`, ride(-6, v));
console.log('big line 16 with 360 spins:', ride(-6, 16, false, Math.PI * 2));
