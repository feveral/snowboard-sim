// World rendering: sky, mountains, snow terrain, trees, rocks, chairlift, gates, snowfall.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  height, surface, pisteCenter, treesInRect, rocksInRect, liftX, LIFT_TOWER_SPACING,
  gatesInRange, GATE_HALF, parkMask, parkAt, PARK_FEATURES, PARK_LEN, PARK_HALF, PARK_PERIOD, PARK_START, parkFeatures,
} from './terrain.js';
import { hash2, noise2, fbm, clamp, smoothstep } from './noise.js';

export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();
export const HAZE = new THREE.Color(0xc9d9ea);
export const FOGREF = { color: new THREE.Color(0xc9d9ea) };

// ------------------------------------------------------------------ helpers
function canvasTex(size, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function setColor(geo, hex, jitter = 0, seed = 0) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = jitter ? (hash2(i + seed, 3) - 0.5) * jitter : 0;
    arr[i * 3] = c.r + j; arr[i * 3 + 1] = c.g + j; arr[i * 3 + 2] = c.b + j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// ------------------------------------------------------------------ sky
export function makeSky() {
  const g = new THREE.SphereGeometry(1400, 32, 16);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3f78c4) }, mid: { value: new THREE.Color(0x8fb6e3) },
      bot: { value: HAZE }, sunDir: { value: SUN_DIR },
    },
    vertexShader: 'varying vec3 vd; void main(){ vd = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; uniform vec3 sunDir; varying vec3 vd;
      void main(){
        float y = vd.y;
        vec3 c = mix(bot, mid, smoothstep(-0.02, 0.18, y));
        c = mix(c, top, smoothstep(0.18, 0.75, y));
        float s = max(dot(normalize(vd), sunDir), 0.0);
        c += vec3(1.0, 0.93, 0.8) * (pow(s, 600.0) * 3.0 + pow(s, 24.0) * 0.25 + pow(s, 4.0) * 0.06);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(g, m);
  sky.frustumCulled = false;
  sky.renderOrder = -2;
  return sky;
}

// distant mountain ranges, kept centred on the camera
export function makeMountains() {
  const group = new THREE.Group();
  const layers = [
    { R: 1300, base: -190, amp: 230, seed: 7, haze: 0.5, n: 300, rows: 10 },
    { R: 1000, base: -210, amp: 170, seed: 1, haze: 0.32, n: 300, rows: 10 },
  ];
  for (const L of layers) {
    const pos = [], col = [], idx = [];
    const snow = new THREE.Color(0xf5f8fc), rock = new THREE.Color(0x59606b), forest = new THREE.Color(0x2f4236);
    const R = L.rows;
    for (let i = 0; i <= L.n; i++) {
      const a = (i / L.n) * Math.PI * 2;
      const u = i / L.n * 30;
      // ridged multi-fractal skyline
      let ridge = 0;
      for (let o = 0; o < 5; o++) {
        const f = Math.pow(2, o);
        ridge += (1 - Math.abs(noise2(u * f * 0.45 + L.seed * 13, L.seed + o * 3.1))) / f;
      }
      ridge = Math.pow(ridge / 1.75, 2.4);
      const top = L.base + L.amp * ridge;
      const snowline = L.base + L.amp * (0.3 + 0.08 * noise2(u * 2, L.seed));
      const foot = L.base - 260;
      for (let r = 0; r <= R; r++) {
        const t = r / R;
        // slopes: concave profile, pushed back as they rise so faces have real shading
        const y = foot + (top - foot) * Math.pow(t, 0.8);
        const rr = L.R + 140 * (t * t) * (0.6 + 0.4 * noise2(u * 3, r * 0.3 + L.seed));
        const wob = 18 * noise2(u * 6, r * 0.5 + L.seed) * t;
        pos.push(Math.sin(a) * (rr + wob), y, Math.cos(a) * (rr + wob));
        let c;
        const gully = noise2(u * 14, t * 4 + L.seed) * 0.5 + 0.5;
        if (y < snowline - 50) c = forest.clone().lerp(snow, 0.25);
        else if (y < snowline) c = rock.clone().lerp(snow, 0.45 + 0.3 * gully);
        else c = snow.clone().lerp(rock, Math.max(0, gully - 0.62) * 1.6);
        c.lerp(HAZE, L.haze * (1.1 - t * 0.4));
        col.push(c.r, c.g, c.b);
      }
      if (i < L.n) for (let r = 0; r < R; r++) {
        const b0 = i * (R + 1) + r, b1 = (i + 1) * (R + 1) + r;
        idx.push(b0, b0 + 1, b1, b0 + 1, b1 + 1, b1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false, flatShading: true }));
    m.renderOrder = -1;
    m.frustumCulled = false;
    group.add(m);
  }
  return group;
}

// ------------------------------------------------------------------ snow material
function snowNormalMap() {
  const S = 256;
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // tileable bumpy wind-packed snow
    const u = x / S * Math.PI * 2, v = y / S * Math.PI * 2;
    let h = 0;
    for (let o = 0; o < 4; o++) {
      const f = 1 << o;
      h += (Math.sin(u * f * 3 + Math.sin(v * f * 2 + o) * 1.7) * Math.cos(v * f * 3 + Math.cos(u * f * 2 - o) * 1.3)) / f;
    }
    h += (hash2(x, y) - 0.5) * 0.35;
    hgt[y * S + x] = h;
  }
  return canvasTex(S, (g) => {
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const hl = hgt[y * S + ((x - 1 + S) % S)], hr = hgt[y * S + ((x + 1) % S)];
      const hd = hgt[((y - 1 + S) % S) * S + x], hu = hgt[((y + 1) % S) * S + x];
      let nx = (hl - hr) * 0.9, ny = (hd - hu) * 0.9, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const i = (y * S + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  });
}

export function makeSnowMaterial() {
  const nm = snowNormalMap();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0, normalMap: nm, normalScale: new THREE.Vector2(0.55, 0.55),
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 surf; varying vec3 vSurf; varying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSurf = surf; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vSurf; varying vec3 vWPos;
        float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // groomer corduroy: fine ridges along the fall line, faded out where they would alias
          float cx = vWPos.x * 3.2;
          float w = fwidth(cx);
          float ridge = smoothstep(0.5 - w, 0.5 + w, abs(fract(cx) - 0.5) * 2.0);
          float fade = 1.0 - smoothstep(0.15, 0.55, w);
          float band = 0.5 + 0.5 * sin(vWPos.x * 0.78 + sin(vWPos.z * 0.01) * 2.0);
          float groom = vSurf.x;
          diffuseColor.rgb *= 1.0 - groom * (0.07 * ridge * fade + 0.025 * band);
          // ice: darker, bluer
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 0.86, 0.97), vSurf.y);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.28, vSurf.y);`)
      .replace('#include <opaque_fragment>', `
        {
          // glitter: tiny crystals that flash depending on the view angle
          vec3 V = normalize(cameraPosition - vWPos);
          vec2 cell = floor(vWPos.xz * 9.0);
          float r = h21(cell);
          float ang = h21(cell + 17.0) * 6.2831;
          vec3 fn = normalize(vec3(cos(ang) * 0.6, 1.0, sin(ang) * 0.6));
          vec3 H = normalize(V + normalize(vec3(-0.55, 0.62, -0.56)));
          float sp = pow(max(dot(fn, H), 0.0), 140.0) * step(0.9, r);
          float dist = length(cameraPosition - vWPos);
          sp *= 1.0 - smoothstep(6.0, 28.0, dist);
          outgoingLight += vec3(1.6, 1.7, 1.9) * sp * (1.0 - vSurf.y * 0.5);
        }
        #include <opaque_fragment>`);
  };
  return mat;
}

// ------------------------------------------------------------------ terrain mesh
export class TerrainMesh {
  constructor(scene) {
    this.GN = 161; this.GS = 1.6;
    const GN = this.GN;
    this.HALF = (GN - 1) / 2;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(GN * GN * 3);
    this.nor = new Float32Array(GN * GN * 3);
    this.col = new Float32Array(GN * GN * 3);
    this.surf = new Float32Array(GN * GN * 3);
    this.uv = new Float32Array(GN * GN * 2);
    this.h = new Float32Array(GN * GN);
    const idx = new Uint32Array((GN - 1) * (GN - 1) * 6);
    let k = 0;
    for (let j = 0; j < GN - 1; j++) for (let i = 0; i < GN - 1; i++) {
      const a = j * GN + i, b = a + 1, c = a + GN, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('surf', new THREE.BufferAttribute(this.surf, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    this.geo = g;
    const mat = makeSnowMaterial();
    mat.normalMap.repeat.set(1, 1);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.center = { x: 1e9, z: 1e9 };
  }
  rebuild(px, pz) {
    const { GN, GS, HALF } = this;
    const cx = Math.round(px / GS) * GS, cz = Math.round((pz + 75) / GS) * GS;
    this.center = { x: px, z: pz };
    this.cx = cx; this.cz = cz;
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const x = cx + (i - HALF) * GS, z = cz + (j - HALF) * GS;
      const k = j * GN + i;
      const h = height(x, z);
      this.h[k] = h;
      // the detailed park mesh covers the park: tuck the coarse terrain just under it
      const pm = parkMask(x, z);
      this.pos[k * 3] = x; this.pos[k * 3 + 1] = h - 0.12 * pm; this.pos[k * 3 + 2] = z;
      this.uv[k * 2] = x / 2.6; this.uv[k * 2 + 1] = z / 2.6;
      const s = surface(x, z);
      const groom = 1 - s.off;
      this.surf[k * 3] = groom; this.surf[k * 3 + 1] = s.ice; this.surf[k * 3 + 2] = s.off;
      // fresh snow is very slightly warm, packed piste cooler, plus low-frequency mottling
      const mott = 0.03 * fbm(x * 0.05, z * 0.05, 2);
      let r = 0.95 + mott, gg = 0.965 + mott, b = 1.0;
      r += (0.985 - r) * s.off * 0.7; gg += (0.985 - gg) * s.off * 0.7; b += (0.99 - b) * s.off * 0.7;
      this.col[k * 3] = r; this.col[k * 3 + 1] = gg; this.col[k * 3 + 2] = b;
    }
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const k = j * GN + i;
      const hl = this.h[j * GN + Math.max(0, i - 1)], hr = this.h[j * GN + Math.min(GN - 1, i + 1)];
      const hd = this.h[Math.max(0, j - 1) * GN + i], hu = this.h[Math.min(GN - 1, j + 1) * GN + i];
      const sx = (i === 0 || i === GN - 1) ? 1 : 2, sz = (j === 0 || j === GN - 1) ? 1 : 2;
      const nx = -(hr - hl) / (sx * GS), nz = -(hu - hd) / (sz * GS);
      const l = Math.hypot(nx, 1, nz);
      this.nor[k * 3] = nx / l; this.nor[k * 3 + 1] = 1 / l; this.nor[k * 3 + 2] = nz / l;
    }
    for (const a of ['position', 'normal', 'color', 'surf', 'uv']) this.geo.attributes[a].needsUpdate = true;
    this.geo.computeBoundingSphere();
    return { cx, cz, R: HALF * GS };
  }
}

// ------------------------------------------------------------------ trees
function jagged(geo, amt, seed) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-3) continue;
    const a = Math.atan2(z, x);
    const k = 1 + amt * (Math.sin(a * 7 + seed) * 0.6 + (hash2(i + seed * 100, 5) - 0.5));
    p.setX(i, x * k); p.setZ(i, z * k);
    p.setY(i, y - amt * 0.6 * (hash2(i, seed) * r));
  }
  geo.computeVertexNormals();
  return geo;
}
function pineGeometry(variant) {
  const parts = [];
  const tall = variant === 1, bushy = variant === 2;
  const trunkH = tall ? 2.2 : 1.4;
  const trunk = new THREE.CylinderGeometry(0.12, 0.24, trunkH, 7); trunk.translate(0, trunkH / 2, 0);
  parts.push(setColor(trunk, 0x4a3426));
  const nL = tall ? 7 : bushy ? 5 : 6;
  const H = tall ? 11 : bushy ? 6.5 : 8.5;
  for (let l = 0; l < nL; l++) {
    const t = l / (nL - 1);
    const rad = (bushy ? 2.6 : tall ? 1.9 : 2.3) * (1 - t * 0.82) + 0.15;
    const y = trunkH * 0.6 + t * (H - trunkH * 0.6 - 1.2);
    const h = 1.9 + (1 - t) * 1.1;
    const cone = jagged(new THREE.ConeGeometry(rad, h, 10, 2, true), 0.16, l * 3 + variant);
    cone.translate(0, y + h / 2, 0);
    parts.push(setColor(cone, l % 2 ? 0x24432f : 0x1f3b29, 0.05, l * 31));
    // snow lying on the branch layer
    const snow = jagged(new THREE.ConeGeometry(rad * 0.82, h * 0.42, 10, 1, true), 0.2, l * 5 + 1 + variant);
    snow.translate(0, y + h * 0.62, 0);
    parts.push(setColor(snow, 0xe9f0f8, 0.04, l * 13));
  }
  const tip = new THREE.ConeGeometry(0.25, 1.4, 6); tip.translate(0, H + 0.3, 0);
  parts.push(setColor(tip, 0x284a33));
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}
function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.35 * fbm(x * 1.3 + 3, z * 1.3 + y * 0.7, 3);
    p.setXYZ(i, x * k * 1.25, y * k * 0.75, z * k);
  }
  g.computeVertexNormals();
  const n = g.attributes.normal;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const snow = smoothstep(0.45, 0.75, n.getY(i)) * smoothstep(-0.2, 0.3, p.getY(i));
    const v = 0.33 + 0.08 * hash2(i, 9);
    const c = [v, v * 1.02, v * 1.08];
    col[i * 3] = c[0] + (0.93 - c[0]) * snow; col[i * 3 + 1] = c[1] + (0.95 - c[1]) * snow; col[i * 3 + 2] = c[2] + (0.99 - c[2]) * snow;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g.toNonIndexed();
}

export class Props {
  constructor(scene) {
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    this.trees = [0, 1, 2].map((v) => {
      const m = new THREE.InstancedMesh(pineGeometry(v), treeMat, 1600);
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      scene.add(m);
      return m;
    });
    this.rocks = new THREE.InstancedMesh(rockGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), 500);
    this.rocks.castShadow = true; this.rocks.receiveShadow = true; this.rocks.frustumCulled = false;
    scene.add(this.rocks);

    // piste marker poles (orange/black)
    const pole = mergeGeometries([
      setColor(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6).translate(0, 0.75, 0), 0xff7a1a),
      setColor(new THREE.CylinderGeometry(0.036, 0.036, 0.35, 6).translate(0, 1.67, 0), 0x16181d),
    ]);
    this.poles = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), 400);
    this.poles.castShadow = true; this.poles.frustumCulled = false;
    scene.add(this.poles);

    // chairlift
    const towerG = mergeGeometries([
      setColor(new THREE.CylinderGeometry(0.28, 0.4, 11, 8).translate(0, 5.5, 0), 0x8e9aa7),
      setColor(new THREE.BoxGeometry(4.2, 0.3, 0.35).translate(0, 11, 0), 0x6d7885),
      setColor(new THREE.CylinderGeometry(0.25, 0.25, 0.35, 10).rotateZ(Math.PI / 2).translate(-1.7, 10.75, 0), 0x2b2f36),
      setColor(new THREE.CylinderGeometry(0.25, 0.25, 0.35, 10).rotateZ(Math.PI / 2).translate(1.7, 10.75, 0), 0x2b2f36),
      setColor(new THREE.CylinderGeometry(0.9, 0.9, 0.5, 10).translate(0, 0.15, 0), 0x9aa4ae),
    ].map((g) => g.toNonIndexed()));
    this.towers = new THREE.InstancedMesh(towerG, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }), 20);
    this.towers.castShadow = true; this.towers.frustumCulled = false;
    scene.add(this.towers);
    const chairG = mergeGeometries([
      setColor(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 5).translate(0, -1.1, 0), 0x30343b),
      setColor(new THREE.BoxGeometry(1.5, 0.08, 0.55).translate(0, -2.25, 0.15), 0x2b5fae),
      setColor(new THREE.BoxGeometry(1.5, 0.6, 0.08).translate(0, -1.95, -0.12), 0x2b5fae),
      setColor(new THREE.CylinderGeometry(0.02, 0.02, 1.5, 5).rotateZ(Math.PI / 2).translate(0, -1.75, 0.45), 0x30343b),
    ].map((g) => g.toNonIndexed()));
    this.chairs = new THREE.InstancedMesh(chairG, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), 80);
    this.chairs.castShadow = true; this.chairs.frustumCulled = false;
    scene.add(this.chairs);
    this.cablePos = new Float32Array(2 * 400 * 3);
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(this.cablePos, 3));
    this.cables = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0x2a2e35 }));
    this.cables.frustumCulled = false;
    scene.add(this.cables);
    this.liftT = 0;
    this.window = { z0: 0, z1: 0 };

    // slalom gates: pole + panel
    const gateG = mergeGeometries([
      new THREE.CylinderGeometry(0.03, 0.03, 1.9, 6).translate(0, 0.95, 0),
      new THREE.BoxGeometry(0.02, 0.75, 1.1).translate(0, 1.35, 0.55),
      new THREE.CylinderGeometry(0.03, 0.03, 1.9, 6).translate(0, 0.95, 1.1),
    ].map((g) => g.toNonIndexed()));
    this.gates = new THREE.InstancedMesh(gateG, new THREE.MeshStandardMaterial({ roughness: 0.6 }), 60);
    this.gates.castShadow = true; this.gates.frustumCulled = false;
    this.gates.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(60 * 3), 3);
    scene.add(this.gates);
    this.gateList = [];
    this.gateState = new Map(); // k -> 'pass' | 'miss'
  }

  rebuild(cx, cz, R) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const counts = [0, 0, 0];
    treesInRect(cx - R, cx + R, cz - R, cz + R, (t) => {
      const v = t.kind < 0.45 ? 0 : t.kind < 0.8 ? 1 : 2;
      if (counts[v] >= 1600) return;
      p.set(t.x, height(t.x, t.z) - 0.3, t.z);
      q.setFromAxisAngle(Y, t.kind * 40);
      s.set(t.s, t.s * (0.9 + 0.3 * hash2(Math.round(t.z * 3), 7)), t.s);
      m.compose(p, q, s);
      this.trees[v].setMatrixAt(counts[v]++, m);
    });
    this.trees.forEach((tm, i) => { tm.count = counts[i]; tm.instanceMatrix.needsUpdate = true; tm.computeBoundingSphere(); });
    let n = 0;
    rocksInRect(cx - R, cx + R, cz - R, cz + R, (r) => {
      if (n >= 500) return;
      p.set(r.x, height(r.x, r.z) - 0.25 * r.s, r.z);
      q.setFromAxisAngle(Y, r.rot);
      s.set(r.s, r.s, r.s);
      m.compose(p, q, s);
      this.rocks.setMatrixAt(n++, m);
    });
    this.rocks.count = n; this.rocks.instanceMatrix.needsUpdate = true;
    // piste poles every 22 m on both edges
    n = 0;
    const z0 = Math.floor((cz - R) / 22) * 22;
    for (let z = z0; z < cz + R && n < 398; z += 22) {
      for (const side of [-1, 1]) {
        const x = pisteCenter(z) + side * 23;
        p.set(x, height(x, z) - 0.15, z); q.identity(); s.set(1, 1, 1);
        m.compose(p, q, s);
        this.poles.setMatrixAt(n++, m);
      }
    }
    this.poles.count = n; this.poles.instanceMatrix.needsUpdate = true;
    // lift towers
    n = 0;
    this.towerList = [];
    const k0 = Math.floor((cz - R) / LIFT_TOWER_SPACING), k1 = Math.ceil((cz + R) / LIFT_TOWER_SPACING);
    for (let k = k0; k <= k1 && n < 20; k++) {
      const z = k * LIFT_TOWER_SPACING, x = liftX(z), y = height(x, z);
      const zN = z + 1, ang = Math.atan2(liftX(zN) - x, 1);
      p.set(x, y - 0.2, z); q.setFromAxisAngle(Y, ang); s.set(1, 1, 1);
      m.compose(p, q, s);
      this.towers.setMatrixAt(n++, m);
      this.towerList.push({ x, y: y + 10.8, z, ang });
    }
    this.towers.count = n; this.towers.instanceMatrix.needsUpdate = true;
    // cables (two lines, gentle sag between towers)
    let c = 0;
    const T = this.towerList;
    for (let i = 0; i + 1 < T.length; i++) {
      const A = T[i], B = T[i + 1];
      for (const off of [-1.7, 1.7]) {
        const N = 8;
        for (let j = 0; j < N; j++) {
          for (const jj of [j, j + 1]) {
            const t = jj / N;
            const ox = Math.cos(A.ang + (B.ang - A.ang) * t) * off;
            const oz = -Math.sin(A.ang + (B.ang - A.ang) * t) * off;
            const sag = 1.4 * 4 * t * (1 - t);
            if (c < this.cablePos.length / 3) {
              this.cablePos[c * 3] = A.x + (B.x - A.x) * t + ox;
              this.cablePos[c * 3 + 1] = A.y + (B.y - A.y) * t - sag;
              this.cablePos[c * 3 + 2] = A.z + (B.z - A.z) * t + oz;
              c++;
            }
          }
        }
      }
    }
    this.cables.geometry.setDrawRange(0, c);
    this.cables.geometry.attributes.position.needsUpdate = true;
    this.window = { z0: cz - R, z1: cz + R };
    // gates
    this.gateList = [];
    gatesInRange(cz - R, cz + R, (g) => this.gateList.push(g));
    this.paintGates();
  }

  paintGates() {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const red = new THREE.Color(0xe0283c), blue = new THREE.Color(0x1f5fd6), ok = new THREE.Color(0x27c46b), miss = new THREE.Color(0x777f8a);
    let n = 0;
    for (const g of this.gateList) {
      if (n >= 60) break;
      // panel hangs on the outside of the gate: inner pole at x - side*GATE_HALF... we place the
      // gate as the outer flag; the opening is between it and an inner pole
      for (const sgn of [-1, 1]) {
        const x = g.x + sgn * (GATE_HALF + 0.55);
        p.set(x, height(x, g.z) - 0.1, g.z);
        q.setFromAxisAngle(Y, sgn > 0 ? Math.PI / 2 : -Math.PI / 2);
        m.compose(p, q, s);
        if (n < 60) {
          this.gates.setMatrixAt(n, m);
          const st = this.gateState.get(g.k);
          this.gates.setColorAt(n, st === 'pass' ? ok : st === 'miss' ? miss : g.color === 'red' ? red : blue);
          n++;
        }
      }
    }
    this.gates.count = n;
    this.gates.instanceMatrix.needsUpdate = true;
    this.gates.instanceColor.needsUpdate = true;
  }

  update(dt) {
    // chairs ride the cable: up on the +x line, down on the -x line
    this.liftT += dt;
    const T = this.towerList;
    if (!T || T.length < 2) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const spacing = 16, speed = 4.2;
    let n = 0;
    for (const dir of [1, -1]) {
      const off = dir > 0 ? -1.7 : 1.7;
      const zStart = T[0].z, zEnd = T[T.length - 1].z;
      const phase = ((dir * -this.liftT * speed) % spacing + spacing) % spacing;
      for (let z = zStart + phase; z < zEnd && n < 80; z += spacing) {
        const i = Math.min(T.length - 2, Math.floor((z - zStart) / LIFT_TOWER_SPACING));
        const A = T[i], B = T[i + 1];
        const t = (z - A.z) / (B.z - A.z);
        const ang = A.ang + (B.ang - A.ang) * t;
        const sag = 1.4 * 4 * t * (1 - t);
        p.set(A.x + (B.x - A.x) * t + Math.cos(ang) * off, A.y + (B.y - A.y) * t - sag, A.z + (B.z - A.z) * t - Math.sin(ang) * off);
        q.setFromAxisAngle(Y, ang + (dir > 0 ? Math.PI : 0) + Math.sin(this.liftT * 1.3 + z) * 0.03);
        m.compose(p, q, s);
        this.chairs.setMatrixAt(n++, m);
      }
    }
    this.chairs.count = n;
    this.chairs.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ particles (shader points with per-particle fade)
export function makePointsMaterial(map, size, color = 0xffffff) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { map: { value: map }, size: { value: size }, color: { value: new THREE.Color(color) }, fogColor: { value: FOGREF.color }, fogNear: { value: 45 }, fogFar: { value: 260 } },
    vertexShader: `attribute float alpha; attribute float psize; varying float vA; varying float vFog; uniform float size;
      void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = size * psize * (300.0 / -mv.z); vFog = -mv.z; }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 color; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; varying float vA; varying float vFog;
      void main(){ vec4 t = texture2D(map, gl_PointCoord); float f = smoothstep(fogNear, fogFar, vFog);
        gl_FragColor = vec4(mix(color, fogColor, f), t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
  });
}
export const DOT = canvasTex(32, (g) => {
  const gr = g.createRadialGradient(16, 16, 1, 16, 16, 15);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
}, false);

// soft, slightly irregular snowflake
export const FLAKE = canvasTex(64, (g) => {
  g.clearRect(0, 0, 64, 64);
  for (let i = 0; i < 7; i++) {
    const a = i / 7 * Math.PI * 2, r = 6 + (i % 3) * 3;
    const x = 32 + Math.cos(a) * r * 0.5, y = 32 + Math.sin(a) * r * 0.5;
    const gr = g.createRadialGradient(x, y, 0, x, y, 16 + (i % 2) * 6);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  }
  const c = g.createRadialGradient(32, 32, 0, 32, 32, 9);
  c.addColorStop(0, 'rgba(255,255,255,1)'); c.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = c; g.fillRect(0, 0, 64, 64);
}, false);

// Snowfall: flakes live in world space inside a box that wraps around the camera
// (done in the vertex shader), so riding fast streams you through the snow.
function snowLayer(N, box, size, nearFade) {
  const base = new Float32Array(N * 3), rnd = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    base[i * 3] = Math.random() * box[0]; base[i * 3 + 1] = Math.random() * box[1]; base[i * 3 + 2] = Math.random() * box[2];
    rnd[i * 4] = 0.45 + Math.random() * Math.random() * 1.6;   // size
    rnd[i * 4 + 1] = Math.random() * 6.283;                      // phase
    rnd[i * 4 + 2] = 0.7 + Math.random() * 0.8;                  // fall speed
    rnd[i * 4 + 3] = Math.random();                              // density slot
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(base, 3));
  g.setAttribute('rnd', new THREE.BufferAttribute(rnd, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      map: { value: FLAKE }, uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uWind: { value: new THREE.Vector2() },
      uBox: { value: new THREE.Vector3(...box) }, uSize: { value: size }, uDensity: { value: 1 }, uNear: { value: nearFade },
      fogColor: { value: FOGREF.color }, uLight: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: `attribute vec4 rnd; uniform vec3 uCam; uniform float uTime; uniform vec2 uWind; uniform vec3 uBox; uniform float uSize; uniform float uDensity; uniform float uNear;
      varying float vA; varying float vFog; varying float vRot;
      void main(){
        float ph = rnd.y;
        vec3 p = position + vec3(uWind.x, -uTime * rnd.z, uWind.y);
        p.x += sin(uTime * (0.9 + rnd.z) + ph) * 0.35;
        p.z += cos(uTime * (0.7 + rnd.z * 0.6) + ph * 1.3) * 0.3;
        vec3 o = uCam - uBox * 0.5;
        p = mod(p - o, uBox) + o;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        gl_PointSize = clamp(uSize * rnd.x * (300.0 / max(d, 0.1)), 1.0, 90.0);
        vA = step(rnd.w, uDensity) * smoothstep(uNear * 0.4, uNear, d) * (0.55 + 0.45 * rnd.x / 2.0);
        vFog = d; vRot = ph + uTime * (rnd.z - 1.1);
      }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 fogColor; uniform vec3 uLight; varying float vA; varying float vFog; varying float vRot;
      void main(){
        if (vA < 0.01) discard;
        vec2 c = gl_PointCoord - 0.5; float s = sin(vRot), co = cos(vRot);
        c = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
        float a = texture2D(map, c).a * vA * (vFog < 3.0 ? 0.45 : 1.0);
        float f = smoothstep(10.0, 60.0, vFog);
        gl_FragColor = vec4(mix(uLight, fogColor, f * 0.6), a * (1.0 - f * 0.5));
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

export class Snowfall {
  constructor(scene) {
    this.main = snowLayer(7000, [70, 36, 70], 0.085, 0.4);
    this.near = snowLayer(200, [10, 7, 10], 0.26, 1.2); // big soft flakes drifting past the lens
    scene.add(this.main, this.near);
    this.t = 0; this.wind = new THREE.Vector2();
    this.setIntensity(1);
  }
  setIntensity(k) {
    this.main.material.uniforms.uDensity.value = k;
    this.near.material.uniforms.uDensity.value = Math.max(0, (k - 0.3) / 0.7) * 0.6;
    this.near.material.uniforms.uSize.value = 0.26;
  }
  setLight(c) { this.main.material.uniforms.uLight.value.copy(c); this.near.material.uniforms.uLight.value.copy(c); }
  update(dt, cam, storm = 0) {
    this.t += dt;
    const t = this.t;
    const gust = 1 + storm * 2.5;
    this.wind.x += (1.2 * Math.sin(t * 0.17) + 0.7 * Math.sin(t * 0.61)) * gust * dt;
    this.wind.y += (-0.6 + 0.6 * Math.sin(t * 0.29)) * gust * dt;
    for (const L of [this.main, this.near]) {
      const u = L.material.uniforms;
      u.uCam.value.copy(cam); u.uTime.value = t; u.uWind.value.copy(this.wind);
    }
  }
}

// ------------------------------------------------------------------ lodge + trail signs
export function makeLodge() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 0.85 });
  const stone = new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 0.95 });
  const snow = new THREE.MeshStandardMaterial({ color: 0xf2f6fb, roughness: 0.8 });
  const win = new THREE.MeshStandardMaterial({ color: 0x2a2f38, emissive: 0xffb257, emissiveIntensity: 0.2, roughness: 0.3 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(10, 1.2, 8), stone); base.position.y = 0.6;
  const body = new THREE.Mesh(new THREE.BoxGeometry(9.6, 3.6, 7.6), wood); body.position.y = 3;
  const roofShape = new THREE.Shape(); roofShape.moveTo(-5.6, 0); roofShape.lineTo(0, 3.4); roofShape.lineTo(5.6, 0); roofShape.lineTo(-5.6, 0);
  const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: 9.2, bevelEnabled: false }), snow);
  roof.position.set(0, 4.8, -4.6);
  const eave = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.25, 9.4), wood); eave.position.y = 4.8;
  const chim = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.4, 0.9), stone); chim.position.set(2.6, 7, 1.5);
  g.add(base, body, roof, eave, chim);
  for (const [x, z, ry] of [[-2.5, 3.81, 0], [2.5, 3.81, 0], [-2.5, -3.81, 0], [2.5, -3.81, 0], [4.81, 0, Math.PI / 2], [-4.81, 0, Math.PI / 2]]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.2), win); w.position.set(x, 3.2, z); w.rotation.y = ry;
    if (z < 0 || x < -4) w.rotation.y += Math.PI;
    g.add(w);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 3), wood); deck.position.set(0, 0.9, 5.4); g.add(deck);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.win = win;
  return g;
}
export function makeSign(lines) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#f7f3e8'; x.fillRect(0, 0, 512, 256);
  x.strokeStyle = '#2d2a26'; x.lineWidth = 10; x.strokeRect(5, 5, 502, 246);
  lines.forEach((l, i) => {
    const y = 70 + i * 100;
    x.fillStyle = l.color; x.beginPath();
    if (l.shape === 'diamond') { x.moveTo(60, y - 30); x.lineTo(90, y); x.lineTo(60, y + 30); x.lineTo(30, y); }
    else if (l.shape === 'square') x.rect(32, y - 26, 52, 52);
    else x.arc(60, y, 28, 0, 7);
    x.fill();
    x.fillStyle = '#1d1b19'; x.font = 'bold 44px sans-serif'; x.textBaseline = 'middle';
    x.fillText(l.text, 110, y);
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const g = new THREE.Group();
  const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), new THREE.MeshStandardMaterial({ map: t, roughness: 0.8, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.45 }));
  board.position.y = 2.2;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), new THREE.MeshStandardMaterial({ color: 0x5a3b26 }));
  post.position.y = 1.3;
  board.castShadow = post.castShadow = true;
  g.add(board, post);
  return g;
}

// ------------------------------------------------------------------ clouds
function cloudTexture(seed) {
  return canvasTex(256, (g, S) => {
    g.clearRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      const x = S * (0.15 + 0.7 * hash2(i, seed)), y = S * (0.35 + 0.3 * hash2(seed, i)), r = S * (0.08 + 0.14 * hash2(i + 9, seed + 3));
      const gr = g.createRadialGradient(x, y, 1, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }
  }, false);
}

// ------------------------------------------------------------------ time of day + weather
const lerpC = (a, b, t) => a.clone().lerp(b, t);
export class Atmosphere {
  constructor(scene, sky, mountains, sun, hemi, snowfall) {
    Object.assign(this, { scene, sky, mountains, sun, hemi, snowfall });
    this.t = 0.12;            // 0 morning -> 0.5 midday -> 1 golden hour (ping-pong)
    this.weather = 0;         // 0 clear .. 1 storm (smoothed)
    this.weatherTarget = 0;
    this.nextWeather = 50;
    this.clock = 0;
    this.clouds = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.SpriteMaterial({ map: cloudTexture(i + 1), fog: false, depthWrite: false, transparent: true, opacity: 0.8 });
      const s = new THREE.Sprite(m);
      s.userData = { a: (i / 12) * Math.PI * 2 + Math.random() * 0.3, r: 700 + Math.random() * 300, h: 110 + Math.random() * 120, w: 260 + Math.random() * 260 };
      s.renderOrder = -1;
      scene.add(s); this.clouds.push(s);
    }
    this.fogColor = HAZE.clone();
    this.label = '';
  }
  update(dt, cam) {
    this.clock += dt;
    // day: 9-minute ping-pong between morning and golden hour
    const ph = (this.clock / 540 + 0.12) % 2;
    this.t = ph < 1 ? ph : 2 - ph;
    // weather: pick a new target every 60–130 s
    this.nextWeather -= dt;
    if (this.nextWeather <= 0) {
      const r = Math.random();
      this.weatherTarget = r < 0.45 ? 0 : r < 0.8 ? 0.5 : 1;
      this.nextWeather = 60 + Math.random() * 70;
    }
    this.weather += (this.weatherTarget - this.weather) * Math.min(1, dt * 0.08);
    const t = this.t, w = this.weather;
    // sun path: elevation peaks at midday, warm and low at the ends
    const elev = THREE.MathUtils.lerp(0.13, 0.95, Math.sin(Math.PI * Math.min(1, t * 1.05)));
    const az = THREE.MathUtils.lerp(-2.3, 0.6, t);
    SUN_DIR.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)).normalize();
    const golden = 1 - smoothstep(0.08, 0.35, Math.sin(elev));
    // colours
    const topClear = lerpC(new THREE.Color(0x3a74c6), new THREE.Color(0x3d5f9c), golden);
    const midClear = lerpC(new THREE.Color(0x92b8e4), new THREE.Color(0xe6b48a), golden * 0.85);
    const hazeClear = lerpC(new THREE.Color(0xcfdced), new THREE.Color(0xf1cfa9), golden * 0.8);
    const storm = new THREE.Color(0xb8c2cc), stormTop = new THREE.Color(0x8f9aa6);
    const top = lerpC(topClear, stormTop, w), mid = lerpC(midClear, storm, w), haze = lerpC(hazeClear, new THREE.Color(0xc4ccd4), w);
    const u = this.sky.material.uniforms;
    u.top.value.copy(top); u.mid.value.copy(mid); u.bot.value.copy(haze); u.sunDir.value.copy(SUN_DIR);
    u.sunAmt = u.sunAmt || { value: 1 };
    this.fogColor.copy(haze);
    this.scene.fog.color.copy(haze);
    FOGREF.color.copy(haze);
    this.scene.fog.near = THREE.MathUtils.lerp(60, 12, w);
    this.scene.fog.far = THREE.MathUtils.lerp(330, 95, w);
    // light
    const sunCol = lerpC(new THREE.Color(0xfff4e2), new THREE.Color(0xffb36b), golden);
    this.sun.color.copy(sunCol);
    this.sun.intensity = THREE.MathUtils.lerp(2.6, 1.7, golden) * (1 - 0.75 * w);
    this.hemi.color.copy(lerpC(new THREE.Color(0xdcebff), new THREE.Color(0xf0dccb), golden * 0.6));
    this.hemi.groundColor.copy(lerpC(new THREE.Color(0x7d90ab), new THREE.Color(0x8a7f8f), golden));
    this.hemi.intensity = THREE.MathUtils.lerp(1.15, 1.0, golden) + 0.55 * w;
    this.mountains.children.forEach((m, i) => m.material.color.copy(lerpC(new THREE.Color(1, 1, 1), new THREE.Color(0xffe6cf), golden * 0.5)).lerp(haze, w * 0.95).multiplyScalar(i === 0 ? 0.95 : 0.9));
    // snowfall density
    this.snowfall.setIntensity(0.1 + 0.9 * smoothstep(0.15, 0.9, w));
    this.snowfall.setLight(lerpC(new THREE.Color(1, 1, 1), new THREE.Color(1, 0.88, 0.76), golden * 0.7));
    // clouds drift around the sky
    for (const c of this.clouds) {
      const d = c.userData;
      d.a += dt * 0.004;
      c.position.set(cam.x + Math.sin(d.a) * d.r, cam.y + d.h, cam.z + Math.cos(d.a) * d.r);
      c.scale.set(d.w * (1 + w), d.w * 0.45 * (1 + w * 0.6), 1);
      c.material.opacity = 0.55 + 0.4 * w;
      c.material.color.copy(lerpC(new THREE.Color(1, 1, 1), new THREE.Color(0xffd0a8), golden * 0.7)).lerp(new THREE.Color(0xc9d0d8), w);
    }
    const tod = t < 0.3 ? '早晨' : t < 0.7 ? '午間' : '黃昏';
    const wx = w < 0.25 ? '晴' : w < 0.7 ? '小雪' : '大雪起霧';
    this.label = `${tod} · ${wx}`;
  }
}

// ------------------------------------------------------------------ terrain park
function textPlane(text, w, h, bg, fg, font = 'bold 120px sans-serif') {
  const c = document.createElement('canvas'); c.width = 1024; c.height = Math.round(1024 * h / w);
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = fg; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.7, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.35 }));
}
export class ParkVisuals {
  constructor(scene) { this.scene = scene; this.group = null; this.k = -1; this.snowMat = makeSnowMaterial(); }
  update(cz) {
    const k = Math.round((cz - PARK_START - PARK_LEN / 2) / PARK_PERIOD);
    const z0 = PARK_START + k * PARK_PERIOD;
    const near = k >= 0 && Math.abs(cz - (z0 + PARK_LEN / 2)) < PARK_LEN / 2 + 280;
    if (!near) { if (this.group) this.group.visible = false; return; }
    if (this.group) this.group.visible = true;
    if (k === this.k) return;
    this.k = k;
    if (this.group) { this.scene.remove(this.group); this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
    this.group = this.build(z0);
    this.scene.add(this.group);
  }
  build(z0) {
    const G = new THREE.Group();
    // ---- fine mesh over the park (0.5 m grid) so lips and landings are crisp
    const step = 0.5, u0 = -20, u1 = PARK_LEN + 20, half = PARK_HALF + 6;
    const NU = Math.round((u1 - u0) / step) + 1, NX = Math.round(2 * half / step) + 1;
    const pos = new Float32Array(NU * NX * 3), col = new Float32Array(NU * NX * 3), surf = new Float32Array(NU * NX * 3), uv = new Float32Array(NU * NX * 2);
    const blue = [0.25, 0.45, 0.95], orange = [1.0, 0.5, 0.15];
    for (let j = 0; j < NU; j++) {
      const z = z0 + u0 + j * step, c = pisteCenter(z), u = z - z0;
      for (let i = 0; i < NX; i++) {
        const dx = -half + i * step, x = c + dx, k = j * NX + i;
        pos[k * 3] = x; pos[k * 3 + 1] = height(x, z); pos[k * 3 + 2] = z;
        uv[k * 2] = x / 2.6; uv[k * 2 + 1] = z / 2.6;
        surf[k * 3] = 1; surf[k * 3 + 1] = 0; surf[k * 3 + 2] = 0;
        let cc = [0.955, 0.97, 1.0];
        for (const f of PARK_FEATURES) {
          if (f.type !== 'jump') continue;
          const lu = u - f.u, ad = Math.abs(dx - f.off);
          if (ad > f.W / 2 + 0.3) continue;
          if (lu > f.Lt - 0.35 && lu < f.Lt + 0.05) cc = blue;                         // lip line
          else if (lu > f.Lt + f.T - 0.2 && lu < f.Lt + f.T + 0.2 && ad > f.W / 2 - 0.6) cc = orange; // knuckle markers
          else if (lu > 0 && lu < f.Lt + f.T + f.Ll && ad > f.W / 2 - 0.25) cc = [0.86, 0.9, 0.97]; // side walls
        }
        col[k * 3] = cc[0]; col[k * 3 + 1] = cc[1]; col[k * 3 + 2] = cc[2];
      }
    }
    const idx = new Uint32Array((NU - 1) * (NX - 1) * 6);
    let n = 0;
    for (let j = 0; j < NU - 1; j++) for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('surf', new THREE.BufferAttribute(surf, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    // fade the mesh edge into the surrounding terrain
    const mesh = new THREE.Mesh(g, this.snowMat);
    mesh.receiveShadow = true;
    G.add(mesh);

    // ---- boxes
    const metal = new THREE.MeshStandardMaterial({ color: 0xc9d2dc, metalness: 0.85, roughness: 0.25 });
    const sideM = new THREE.MeshStandardMaterial({ color: 0x1f8f5f, roughness: 0.6 });
    for (const f of PARK_FEATURES) {
      if (f.type !== 'box') continue;
      const za = z0 + f.u + 1.2, zb = z0 + f.u + f.len;
      const xa = pisteCenter(za) + f.off, xb = pisteCenter(zb) + f.off;
      const ya = height(xa, za), yb = height(xb, zb);
      const A = new THREE.Vector3(xa, ya, za), B = new THREE.Vector3(xb, yb, zb);
      const L = A.distanceTo(B);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.86, f.h, L), sideM);
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, L), metal);
      top.position.y = f.h / 2;
      const box = new THREE.Group(); box.add(body, top);
      box.position.copy(A).lerp(B, 0.5).add(new THREE.Vector3(0, -f.h / 2 + 0.01, 0));
      box.lookAt(B.clone().add(new THREE.Vector3(0, -f.h / 2 + 0.01, 0)));
      body.castShadow = top.castShadow = true;
      G.add(box);
      const sign = textPlane(f.name, 1.6, 0.6, '#1f8f5f', '#fff', 'bold 220px sans-serif');
      const sx = pisteCenter(za - 9) + f.off + (f.off > 0 ? 1.6 : -1.6);
      sign.position.set(sx, height(sx, za - 9) + 1.6, za - 9); sign.rotation.y = Math.PI;
      G.add(sign);
    }
    // ---- size signs before each jump
    const sizeCol = { S: '#2a9d4b', M: '#1f5fd6', L: '#111111', XL: '#d6333f' };
    for (const f of PARK_FEATURES) {
      if (f.type !== 'jump') continue;
      const z = z0 + f.u - 10, x = pisteCenter(z) + f.off + (f.off > 0 ? 4.5 : -4.5);
      const s = textPlane(f.name, 1.0, 1.0, sizeCol[f.name] || '#333', '#fff', 'bold 560px sans-serif');
      s.position.set(x, height(x, z) + 1.5, z); s.rotation.y = Math.PI;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), new THREE.MeshStandardMaterial({ color: 0x333333 }));
      post.position.set(x, height(x, z) + 0.6, z);
      G.add(s, post);
    }
    // ---- entrance banner
    const zb = z0 - 14, cb = pisteCenter(zb);
    const banner = textPlane('TERRAIN PARK', 14, 1.8, '#111318', '#ffffff', 'bold 150px sans-serif');
    const yb = Math.max(height(cb - 8, zb), height(cb + 8, zb)) + 5.2;
    banner.position.set(cb, yb, zb); banner.rotation.y = Math.PI;
    G.add(banner);
    for (const sx of [-7.5, 7.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 7, 8), new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.5 }));
      post.position.set(cb + sx, height(cb + sx, zb) + 3.2, zb); post.castShadow = true;
      G.add(post);
    }
    // ---- orange fences along both sides
    const fenceM = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.7, transparent: true, opacity: 0.9 });
    for (const side of [-1, 1]) {
      for (let u = -8; u < PARK_LEN; u += 6) {
        const za = z0 + u, zb2 = z0 + u + 6;
        const xa = pisteCenter(za) + side * (PARK_HALF + 2.5), xb = pisteCenter(zb2) + side * (PARK_HALF + 2.5);
        const A = new THREE.Vector3(xa, height(xa, za) + 0.6, za), B = new THREE.Vector3(xb, height(xb, zb2) + 0.6, zb2);
        const net = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.8, A.distanceTo(B)), fenceM);
        net.position.copy(A).lerp(B, 0.5); net.lookAt(B);
        G.add(net);
      }
    }
    return G;
  }
}
