// Tracks in the snow (carve grooves / skid scrapes) and snow spray.
import * as THREE from 'three';
import { height } from './terrain.js';
import { makePointsMaterial, DOT } from './env.js';
import { smoothstep } from './noise.js';

function stripTexture(draw, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// cross-section of a carved groove: bright lip, deep shadowed cut, polished wall
const grooveTex = stripTexture((g, w, h) => {
  const gr = g.createLinearGradient(0, 0, w, 0);
  gr.addColorStop(0.0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.18, 'rgba(250,252,255,0.9)');
  gr.addColorStop(0.36, 'rgba(140,158,188,0.9)');
  gr.addColorStop(0.48, 'rgba(95,115,150,1)');
  gr.addColorStop(0.56, 'rgba(165,182,210,1)');
  gr.addColorStop(0.75, 'rgba(225,234,246,0.9)');
  gr.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}, 64, 4);
// scraped/skidded band: smoothed snow with streaks along the slide
const scrapeTex = stripTexture((g, w, h) => {
  g.clearRect(0, 0, w, h);
  for (let x = 0; x < w; x++) {
    const edge = Math.min(x, w - 1 - x) / (w * 0.5);
    const a = Math.min(1, edge * 2.2) * 0.85;
    const v = 165 + Math.random() * 35;
    g.fillStyle = `rgba(${v - 22},${v - 8},${Math.min(255, v + 28)},${a})`;
    g.fillRect(x, 0, 1, h);
  }
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * w, y = Math.random() * h, l = 20 + Math.random() * 120;
    g.fillStyle = `rgba(120,140,175,${0.2 + Math.random() * 0.3})`;
    g.fillRect(x, y, 1, l);
  }
}, 64, 256);

class Ribbon {
  constructor(scene, tex, maxSeg, opacity) {
    this.max = maxSeg;
    this.pos = new Float32Array(maxSeg * 6 * 3);
    this.nor = new Float32Array(maxSeg * 6 * 3);
    this.uv = new Float32Array(maxSeg * 6 * 2);
    this.col = new Float32Array(maxSeg * 6 * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    this.geo = g;
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: tex, vertexColors: true, transparent: true, opacity, roughness: 0.6, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    }));
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.head = 0; this.prev = null; this.v = 0;
  }
  clear() { this.pos.fill(0); this.col.fill(0); this.prev = null; this.head = 0; this.dirty(); }
  dirty() { for (const k of ['position', 'normal', 'uv', 'color']) this.geo.attributes[k].needsUpdate = true; }
  break() { this.prev = null; }
  add(cx, cz, rx, rz, w, n, alpha, step) {
    const L = [cx + rx * w / 2, 0, cz + rz * w / 2], R = [cx - rx * w / 2, 0, cz - rz * w / 2];
    L[1] = height(L[0], L[2]) + 0.05; R[1] = height(R[0], R[2]) + 0.05;
    this.v += step / Math.max(0.3, w * 1.5);
    const cur = { L, R, n, a: alpha, v: this.v };
    const p = this.prev;
    if (p) {
      const base = this.head * 6;
      const verts = [p.L, p.R, cur.L, p.R, cur.R, cur.L];
      const us = [0, 1, 0, 1, 1, 0];
      const vs = [p.v, p.v, cur.v, p.v, cur.v, cur.v];
      const as = [p.a, p.a, cur.a, p.a, cur.a, cur.a];
      for (let k = 0; k < 6; k++) {
        const i = base + k;
        this.pos.set(verts[k], i * 3);
        this.nor.set(n, i * 3);
        this.uv[i * 2] = us[k]; this.uv[i * 2 + 1] = vs[k];
        this.col[i * 4] = 1; this.col[i * 4 + 1] = 1; this.col[i * 4 + 2] = 1; this.col[i * 4 + 3] = as[k];
      }
      this.head = (this.head + 1) % this.max;
      this.dirty();
    }
    this.prev = cur;
  }
}

export class Tracks {
  constructor(scene) {
    this.groove = new Ribbon(scene, grooveTex, 6000, 1);
    this.scrape = new Ribbon(scene, scrapeTex, 4000, 0.95);
    this.acc = 0;
  }
  clear() { this.groove.clear(); this.scrape.clear(); }
  update(rider, dt) {
    const t = rider.tel;
    if (!rider.grounded || rider.crashT > 0 || t.speed < 1) { this.groove.break(); this.scrape.break(); return; }
    const step = t.speed * dt;
    this.acc += step;
    if (this.acc < 0.3) return;
    const st = this.acc; this.acc = 0;
    const p = rider.p, r = rider.r, f = rider.f, n = [rider.n[0], rider.n[1], rider.n[2]];
    const sk = Math.abs(Math.sin(t.betaS)), ck = Math.cos(t.betaS);
    const th = Math.abs(rider.edge);
    // 1) the edge that's in the snow cuts a line; deep & clean when carving, faint when sliding
    const edgeIn = Math.min(1, th / 0.35);
    const grooveA = edgeIn * (0.25 + 0.75 * Math.max(0, 1 - sk / 0.2));
    if (th > 0.08 && grooveA > 0.05) {
      const off = 0.13 * Math.sign(rider.edge);
      this.groove.add(p[0] + r[0] * off, p[2] + r[2] * off, r[0], r[2], 0.09 + 0.06 * Math.min(1, Math.abs(t.latG)), n, grooveA, st);
    } else this.groove.break();
    // 2) the base: every slide leaves a footprint as wide as the board projects across the
    //    travel line (≈ board width when straight, ≈ board length when sideways). Lighter the
    //    more the board is on edge (the base lifts off the snow), heavier in soft snow.
    const L = 1.5, W = 0.27;
    const w = L * sk + W * ck;
    const baseContact = 1 - smoothstep(0.2, 0.75, th) * (1 - sk);
    const a = Math.min(1, (0.32 + 0.6 * Math.min(1, sk / 0.25) + 0.35 * t.off) * baseContact);
    if (a > 0.04) {
      const vx = rider.v[0], vz = rider.v[2], vl = Math.hypot(vx, vz) || 1;
      this.scrape.add(p[0], p[2], -vz / vl, vx / vl, w, n, a, st);
    } else this.scrape.break();
  }
}

export class Spray {
  constructor(scene) {
    const N = this.N = 1200;
    this.pos = new Float32Array(N * 3); this.vel = new Float32Array(N * 3);
    this.life = new Float32Array(N); this.max = new Float32Array(N);
    this.alpha = new Float32Array(N); this.size = new Float32Array(N);
    for (let i = 0; i < N; i++) this.pos[i * 3 + 1] = -1e5;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
    this.geo = g;
    this.pts = new THREE.Points(g, makePointsMaterial(DOT, 0.32));
    this.pts.frustumCulled = false;
    scene.add(this.pts);
    this.next = 0; this.acc = 0;
  }
  emit(count, o, dir, spread, up, base, big = 1) {
    for (let c = 0; c < count; c++) {
      const i = this.next; this.next = (this.next + 1) % this.N;
      this.pos[i * 3] = o[0] + (Math.random() - 0.5) * 0.4;
      this.pos[i * 3 + 1] = o[1] + 0.05;
      this.pos[i * 3 + 2] = o[2] + (Math.random() - 0.5) * 0.4;
      const s = spread * (0.4 + Math.random());
      this.vel[i * 3] = base[0] + dir[0] * s + (Math.random() - 0.5) * 1.4;
      this.vel[i * 3 + 1] = up * (0.4 + Math.random());
      this.vel[i * 3 + 2] = base[2] + dir[2] * s + (Math.random() - 0.5) * 1.4;
      this.max[i] = this.life[i] = 0.45 + Math.random() * 0.7;
      this.size[i] = (0.5 + Math.random()) * big;
    }
  }
  burst(p, n = 120) {
    this.emit(n, p, [0, 0, 0], 0, 3.5, [0, 0, 0], 1.6);
  }
  update(dt) {
    for (let i = 0; i < this.N; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -1e5; this.alpha[i] = 0; continue; }
      this.vel[i * 3 + 1] -= 7.5 * dt;
      const k = Math.exp(-2.5 * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const u = this.life[i] / this.max[i];
      this.alpha[i] = Math.min(1, u * 2.5) * 0.85;
      this.size[i] += dt * 1.2; // puffs expand
    }
    for (const k of ['position', 'alpha', 'psize']) this.geo.attributes[k].needsUpdate = true;
  }
  fromRider(rider, mode, dt) {
    const t = rider.tel;
    if (!rider.grounded || rider.crashT > 0 || t.speed < 2) return;
    const p = rider.p, r = rider.r, f = rider.f, n = rider.n;
    const eS = Math.sign(rider.edge) || 1;
    let rate = 0, dir, spread, up;
    if (t.skid > 0.5) {
      rate = Math.min(320, t.skid * t.speed * 4.5);
      const vrs = Math.sign(rider.v[0] * r[0] + rider.v[2] * r[2]) || 1;
      dir = [r[0] * vrs, 0, r[2] * vrs]; spread = 1.2 + Math.min(4, t.skid * 0.55); up = 1.4 + Math.min(1.8, t.skid * 0.25);
    } else if (mode === 'carve') {
      rate = Math.min(160, t.speed * 4 * Math.min(1.4, Math.abs(t.latG)));
      dir = [-r[0] * eS, 0, -r[2] * eS]; spread = 1.4; up = 1.6;
    } else if (t.off > 0.5) {
      rate = t.speed * 3; dir = [-f[0], 0, -f[2]]; spread = 0.8; up = 1.2; // powder puff
    }
    if (rate <= 0) return;
    this.acc += rate * dt;
    const c = Math.floor(this.acc); this.acc -= c;
    const tail = [p[0] - f[0] * 0.45 + n[0] * 0.05, p[1] + 0.05, p[2] - f[2] * 0.45];
    this.emit(c, tail, dir, spread, up, [rider.v[0] * 0.55, 0, rider.v[2] * 0.55]);
  }
}
