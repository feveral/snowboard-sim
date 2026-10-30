import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrain, height, surface, treesInRect } from './terrain.js';
import { Rider, MODES } from './physics.js';
import { hash2, clamp } from './noise.js';

const D = 180 / Math.PI;
const PHYS_DT = 1 / 120;

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const FOG = new THREE.Color(0xd4e3f2);
scene.fog = new THREE.Fog(FOG, 45, 240);
scene.background = FOG;
const camera = new THREE.PerspectiveCamera(66, 1, 0.1, 700);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // portrait phones: widen the view a bit
  camera.userData.baseFov = w < h ? 74 : 62;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// sky dome
{
  const g = new THREE.SphereGeometry(600, 24, 12);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x5d8fd0) }, bot: { value: FOG } },
    vertexShader: 'varying float vy; void main(){ vy = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying float vy; void main(){ float t = smoothstep(-0.05, 0.55, vy); gl_FragColor = vec4(mix(bot, top, t), 1.0); }',
  });
  const sky = new THREE.Mesh(g, m);
  sky.renderOrder = -1;
  sky.name = 'sky';
  scene.add(sky);
}

scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x7a8ca3, 1.25));
const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
sun.position.set(-40, 70, -30);
scene.add(sun);

// ------------------------------------------------------------------ terrain mesh
const GN = 129, GS = 2.0, HALF = (GN - 1) / 2;
const tGeo = new THREE.BufferGeometry();
const tPos = new Float32Array(GN * GN * 3);
const tNor = new Float32Array(GN * GN * 3);
const tCol = new Float32Array(GN * GN * 3);
const tH = new Float32Array(GN * GN);
{
  const idx = [];
  for (let j = 0; j < GN - 1; j++)
    for (let i = 0; i < GN - 1; i++) {
      const a = j * GN + i, b = a + 1, c = a + GN, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  tGeo.setIndex(idx);
  tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  tGeo.setAttribute('normal', new THREE.BufferAttribute(tNor, 3));
  tGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
}
const tUv = new Float32Array(GN * GN * 2);
tGeo.setAttribute('uv', new THREE.BufferAttribute(tUv, 2));
function snowTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const x = i % S, y = (i / S) | 0;
    // fine grain + soft blotches + faint corduroy lines (along the fall line)
    const grain = (hash2(x, y) - 0.5) * 16;
    const blot = 7 * Math.sin(x * 0.049 + Math.sin(y * 0.031) * 2) * Math.sin(y * 0.043 + Math.sin(x * 0.027) * 2);
    const cord = (x % 8 < 1) ? -7 : 0;
    const v = 238 + grain + blot + cord;
    img.data[i * 4] = v - 3; img.data[i * 4 + 1] = v - 1; img.data[i * 4 + 2] = Math.min(255, v + 6);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const tMesh = new THREE.Mesh(tGeo, new THREE.MeshLambertMaterial({ vertexColors: true, map: snowTexture() }));
tMesh.frustumCulled = false;
scene.add(tMesh);
let terrainCenter = { x: 1e9, z: 1e9 };

function rebuildTerrain(px, pz) {
  const cx = Math.round(px / GS) * GS, cz = Math.round((pz + 70) / GS) * GS;
  terrainCenter = { x: px, z: pz };
  for (let j = 0; j < GN; j++)
    for (let i = 0; i < GN; i++) {
      const x = cx + (i - HALF) * GS, z = cz + (j - HALF) * GS;
      const k = j * GN + i;
      const h = height(x, z);
      tH[k] = h;
      tPos[k * 3] = x; tPos[k * 3 + 1] = h; tPos[k * 3 + 2] = z;
      tUv[k * 2] = x / 7; tUv[k * 2 + 1] = z / 7;
      const s = surface(x, z);
      // groomed snow: cool white; ice: blue-grey; off-piste: slightly warm
      const corduroy = 0.012 * Math.sin(x * 2.2);
      let r = 0.93 + corduroy, g = 0.955 + corduroy, b = 1.0;
      r += (0.74 - r) * s.ice; g += (0.83 - g) * s.ice; b += (0.95 - b) * s.ice;
      r += (0.97 - r) * s.off * 0.6; g += (0.97 - g) * s.off * 0.6; b += (0.985 - b) * s.off * 0.6;
      tCol[k * 3] = r; tCol[k * 3 + 1] = g; tCol[k * 3 + 2] = b;
    }
  for (let j = 0; j < GN; j++)
    for (let i = 0; i < GN; i++) {
      const k = j * GN + i;
      const hl = tH[j * GN + Math.max(0, i - 1)], hr = tH[j * GN + Math.min(GN - 1, i + 1)];
      const hd = tH[Math.max(0, j - 1) * GN + i], hu = tH[Math.min(GN - 1, j + 1) * GN + i];
      const sx = (i === 0 || i === GN - 1) ? 1 : 2, sz = (j === 0 || j === GN - 1) ? 1 : 2;
      const nx = -(hr - hl) / (sx * GS), nz = -(hu - hd) / (sz * GS);
      const l = Math.hypot(nx, 1, nz);
      tNor[k * 3] = nx / l; tNor[k * 3 + 1] = 1 / l; tNor[k * 3 + 2] = nz / l;
    }
  tGeo.attributes.position.needsUpdate = true;
  tGeo.attributes.normal.needsUpdate = true;
  tGeo.attributes.color.needsUpdate = true;
  tGeo.attributes.uv.needsUpdate = true;
  rebuildTrees(cx, cz);
}

// ------------------------------------------------------------------ trees
function colored(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function treeGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.14, 0.22, 1.6, 6); trunk.translate(0, 0.8, 0);
  parts.push(colored(trunk, 0x5a4030));
  const layers = [[2.1, 3.4, 2.5, 0x24452f], [1.65, 3.0, 4.0, 0x2a5236], [1.15, 2.6, 5.5, 0x2f5b3c], [0.6, 1.6, 6.8, 0x355f43]];
  for (const [rad, h, y, col] of layers) {
    const c = new THREE.ConeGeometry(rad, h, 7, 1); c.translate(0, y, 0);
    parts.push(colored(c, col));
    const snow = new THREE.ConeGeometry(rad * 0.72, h * 0.45, 7, 1); snow.translate(0, y + h * 0.3, 0);
    parts.push(colored(snow, 0xeef4fb));
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}
const MAX_TREES = 3500;
const trees = new THREE.InstancedMesh(treeGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_TREES);
trees.frustumCulled = false;
scene.add(trees);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
function rebuildTrees(cx, cz) {
  let n = 0;
  const R = HALF * GS;
  treesInRect(cx - R, cx + R, cz - R, cz + R, (t) => {
    if (n >= MAX_TREES) return;
    _p.set(t.x, height(t.x, t.z) - 0.25, t.z);
    _q.setFromAxisAngle(_yAxis, hash2(Math.round(t.x), Math.round(t.z)) * 6.28);
    _s.set(t.s, t.s * (0.9 + 0.35 * hash2(Math.round(t.z), 7)), t.s);
    _m.compose(_p, _q, _s);
    trees.setMatrixAt(n++, _m);
  });
  trees.count = n;
  trees.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------ rider model
const rider = new Rider(terrain);
const riderRoot = new THREE.Group();
const tilt = new THREE.Group();
riderRoot.add(tilt);
scene.add(riderRoot);

const matJacket = new THREE.MeshLambertMaterial({ color: 0xff6a2b });
const matPants = new THREE.MeshLambertMaterial({ color: 0x2b3446 });
const matDark = new THREE.MeshLambertMaterial({ color: 0x1b1f27 });
const matHelmet = new THREE.MeshLambertMaterial({ color: 0xf3f5f8 });
const matGoggle = new THREE.MeshLambertMaterial({ color: 0x2bb3ff, emissive: 0x0a3550 });
const matBoard = new THREE.MeshLambertMaterial({ color: 0x18c4a5 });
const matBoardTop = new THREE.MeshLambertMaterial({ color: 0x14161c });

// board: local +Z = nose, local +X = rider's LEFT (heel side for regular), facing -X
const board = new THREE.Group();
{
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.025, 1.36), matBoard);
  base.position.y = 0.0125;
  board.add(base);
  for (const sgn of [1, -1]) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.025, 16, 1, false, 0, Math.PI), matBoard);
    tip.rotation.y = sgn > 0 ? -Math.PI / 2 : Math.PI / 2;
    tip.position.set(0, 0.03, sgn * 0.68);
    tip.rotation.x = sgn * -0.18;
    board.add(tip);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.006, 1.2), matBoardTop);
  top.position.y = 0.028;
  board.add(top);
  for (const z of [0.26, -0.26]) {
    const bind = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.13), matDark);
    bind.position.set(0, 0.07, z);
    board.add(bind);
  }
}
tilt.add(board);

function limb(mat, r) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 1, 8), mat);
  tilt.add(m);
  return m;
}
const _up = new THREE.Vector3(0, 1, 0);
function placeLimb(m, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.scale.set(1, len, 1);
  m.quaternion.setFromUnitVectors(_up, dir.normalize());
}
const thighs = [limb(matPants, 0.075), limb(matPants, 0.075)];
const shins = [limb(matPants, 0.065), limb(matPants, 0.065)];
const boots = [0, 1].map(() => { const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.3), matDark); b.rotation.y = Math.PI / 2; tilt.add(b); return b; });
const upperArms = [limb(matJacket, 0.055), limb(matJacket, 0.055)];
const foreArms = [limb(matJacket, 0.05), limb(matJacket, 0.05)];
const gloves = [0, 1].map(() => { const g = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), matDark); tilt.add(g); return g; });
const torso = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.5, 0.4), matJacket);
tilt.add(torso);
const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.36), matPants);
tilt.add(pelvis);
const head = new THREE.Group();
{
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 10), matHelmet);
  head.add(helm);
  const gog = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.2), matGoggle);
  gog.position.set(-0.11, -0.01, 0);
  head.add(gog);
}
tilt.add(head);

const V = (x, y, z) => new THREE.Vector3(x, y, z);
function poseRider(crouch, twist, armSpread, lean) {
  // crouch 0..1, twist (upper body rotation toward the nose), lean forward(-X) / back
  const hipY = 0.92 - 0.32 * crouch;
  const hipX = -0.02 - 0.05 * crouch + lean * 0.12;
  const feet = [V(0, 0.06, 0.26), V(0, 0.06, -0.26)];
  const hips = [V(hipX, hipY, 0.11), V(hipX, hipY, -0.11)];
  for (let i = 0; i < 2; i++) {
    const f = feet[i], h = hips[i];
    const mid = f.clone().add(h).multiplyScalar(0.5);
    const kneeOut = Math.sqrt(Math.max(0, 0.48 * 0.48 - (h.distanceTo(f) / 2) ** 2));
    const knee = mid.add(V(-kneeOut * 0.92, 0, (i === 0 ? 1 : -1) * kneeOut * 0.25));
    placeLimb(thighs[i], h, knee);
    placeLimb(shins[i], knee, f.clone().add(V(0, 0.04, 0)));
    boots[i].position.copy(f).add(V(-0.02, 0.02, 0));
  }
  pelvis.position.set(hipX, hipY + 0.02, 0);
  const tBase = V(hipX - 0.03 - 0.1 * crouch + lean * 0.08, hipY + 0.3, 0);
  torso.position.copy(tBase);
  torso.rotation.set(0, twist, 0.18 + 0.4 * crouch - lean * 0.3);
  const shoulderY = tBase.y + 0.2;
  head.position.set(tBase.x - 0.07 - 0.1 * crouch, shoulderY + 0.2, Math.sin(twist) * 0.05);
  head.rotation.set(0, twist * 1.6 + 0.4, 0);
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    const sh = V(tBase.x + Math.sin(twist) * 0.18 * side * -1, shoulderY, side * 0.2 * Math.cos(twist));
    const elbow = sh.clone().add(V(-0.12, -0.2, side * (0.12 + 0.2 * armSpread)));
    const hand = elbow.clone().add(V(-0.1, -0.18 + 0.1 * armSpread, side * (0.08 + 0.18 * armSpread)));
    placeLimb(upperArms[i], sh, elbow);
    placeLimb(foreArms[i], elbow, hand);
    gloves[i].position.copy(hand);
  }
}
poseRider(0.3, 0.3, 0.3, 0);

// blob shadow
function blobTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(40,55,80,0.55)'); gr.addColorStop(1, 'rgba(40,55,80,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
scene.add(shadow);

// ------------------------------------------------------------------ trails (ribbon)
const MAXSEG = 5000;
const trPos = new Float32Array(MAXSEG * 6 * 3);
const trNor = new Float32Array(MAXSEG * 6 * 3);
const trCol = new Float32Array(MAXSEG * 6 * 3);
const trGeo = new THREE.BufferGeometry();
trGeo.setAttribute('position', new THREE.BufferAttribute(trPos, 3));
trGeo.setAttribute('normal', new THREE.BufferAttribute(trNor, 3));
trGeo.setAttribute('color', new THREE.BufferAttribute(trCol, 3));
const trMesh = new THREE.Mesh(trGeo, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
trMesh.frustumCulled = false;
scene.add(trMesh);
let trHead = 0, trCount = 0, trPrev = null;
function clearTrails() { trPos.fill(0); trHead = 0; trCount = 0; trPrev = null; trGeo.attributes.position.needsUpdate = true; }
function trailPoint(w, col) {
  const p = rider.p, r = rider.r, n = rider.n;
  const lx = p[0] + r[0] * w / 2, lz = p[2] + r[2] * w / 2;
  const rx = p[0] - r[0] * w / 2, rz = p[2] - r[2] * w / 2;
  return { L: [lx, height(lx, lz) + 0.02, lz], R: [rx, height(rx, rz) + 0.02, rz], n: [n[0], n[1], n[2]], col, x: p[0], z: p[2] };
}
function addTrail(w, col) {
  const cur = trailPoint(w, col);
  if (trPrev) {
    const verts = [trPrev.L, trPrev.R, cur.L, trPrev.R, cur.R, cur.L];
    const cols = [trPrev.col, trPrev.col, cur.col, trPrev.col, cur.col, cur.col];
    const base = trHead * 18;
    for (let k = 0; k < 6; k++) {
      trPos.set(verts[k], base + k * 3);
      trNor.set(cur.n, base + k * 3);
      trCol.set(cols[k], base + k * 3);
    }
    trHead = (trHead + 1) % MAXSEG;
    trCount = Math.min(MAXSEG, trCount + 1);
    trGeo.attributes.position.needsUpdate = true;
    trGeo.attributes.normal.needsUpdate = true;
    trGeo.attributes.color.needsUpdate = true;
  }
  trPrev = cur;
}
trGeo.setDrawRange(0, MAXSEG * 6);

// ------------------------------------------------------------------ particles
function dotTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 1, 16, 16, 15);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
const DOT = dotTexture();
// spray
const SPN = 900;
const spPos = new Float32Array(SPN * 3), spVel = new Float32Array(SPN * 3), spLife = new Float32Array(SPN);
const spGeo = new THREE.BufferGeometry();
spGeo.setAttribute('position', new THREE.BufferAttribute(spPos, 3));
const spray = new THREE.Points(spGeo, new THREE.PointsMaterial({ size: 0.22, map: DOT, transparent: true, depthWrite: false, color: 0xffffff, opacity: 0.95 }));
spray.frustumCulled = false;
scene.add(spray);
let spNext = 0, spAcc = 0;
for (let i = 0; i < SPN; i++) spPos[i * 3 + 1] = -1e5;
function emitSpray(count, origin, dir, spread, upv, base) {
  for (let c = 0; c < count; c++) {
    const i = spNext; spNext = (spNext + 1) % SPN;
    spPos[i * 3] = origin[0] + (Math.random() - 0.5) * 0.5;
    spPos[i * 3 + 1] = origin[1] + 0.05;
    spPos[i * 3 + 2] = origin[2] + (Math.random() - 0.5) * 0.5;
    const s = spread * (0.5 + Math.random());
    spVel[i * 3] = base[0] + dir[0] * s + (Math.random() - 0.5) * 1.2;
    spVel[i * 3 + 1] = upv * (0.5 + Math.random());
    spVel[i * 3 + 2] = base[2] + dir[2] * s + (Math.random() - 0.5) * 1.2;
    spLife[i] = 0.5 + Math.random() * 0.6;
  }
}
function updateSpray(dt) {
  for (let i = 0; i < SPN; i++) {
    if (spLife[i] <= 0) continue;
    spLife[i] -= dt;
    if (spLife[i] <= 0) { spPos[i * 3 + 1] = -1e5; continue; }
    spVel[i * 3 + 1] -= 9.81 * dt;
    const k = Math.exp(-2.2 * dt);
    spVel[i * 3] *= k; spVel[i * 3 + 2] *= k;
    spPos[i * 3] += spVel[i * 3] * dt;
    spPos[i * 3 + 1] += spVel[i * 3 + 1] * dt;
    spPos[i * 3 + 2] += spVel[i * 3 + 2] * dt;
  }
  spGeo.attributes.position.needsUpdate = true;
}
// falling snow
const SNN = 2200, SNB = 70;
const snPos = new Float32Array(SNN * 3);
for (let i = 0; i < SNN; i++) { snPos[i * 3] = Math.random() * SNB; snPos[i * 3 + 1] = Math.random() * 40; snPos[i * 3 + 2] = Math.random() * SNB; }
const snGeo = new THREE.BufferGeometry();
snGeo.setAttribute('position', new THREE.BufferAttribute(snPos, 3));
const snowfall = new THREE.Points(snGeo, new THREE.PointsMaterial({ size: 0.13, map: DOT, transparent: true, depthWrite: false, opacity: 0.9 }));
snowfall.frustumCulled = false;
scene.add(snowfall);
let windT = 0;
function updateSnowfall(dt) {
  windT += dt;
  const wx = 1.2 * Math.sin(windT * 0.21) + 0.6 * Math.sin(windT * 0.77);
  const wz = -0.6 + 0.5 * Math.sin(windT * 0.31);
  const ox = camera.position.x - SNB / 2, oy = camera.position.y - 15, oz = camera.position.z - SNB / 2;
  for (let i = 0; i < SNN; i++) {
    let x = snPos[i * 3] + (wx + Math.sin(i * 1.7 + windT) * 0.4) * dt;
    let y = snPos[i * 3 + 1] - (1.1 + (i % 7) * 0.12) * dt;
    let z = snPos[i * 3 + 2] + wz * dt;
    // positions stored relative to a moving box around the camera
    x = ((x % SNB) + SNB) % SNB; y = ((y % 40) + 40) % 40; z = ((z % SNB) + SNB) % SNB;
    snPos[i * 3] = x; snPos[i * 3 + 1] = y; snPos[i * 3 + 2] = z;
  }
  snowfall.position.set(Math.floor(ox / SNB) * SNB, oy, Math.floor(oz / SNB) * SNB);
  // wrap the field so it surrounds the camera
  snowfall.userData.o = [ox, oz];
  snGeo.attributes.position.needsUpdate = true;
}
// (box is tiled by placing a 2x2 set of copies)
const snowCopies = [];
for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
  if (a === 0 && b === 0) continue;
  const c = new THREE.Points(snGeo, snowfall.material); c.frustumCulled = false; scene.add(c); snowCopies.push([c, a, b]);
}

// ------------------------------------------------------------------ input (one thumb)
const input = { steer: 0, pull: 0 };
const touch = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
const keys = new Set();
const stick = document.getElementById('stick'), knob = document.getElementById('knob');
const ui = document.getElementById('ui');

function scaleX() { return Math.min(window.innerWidth, window.innerHeight) * 0.30; }
function scaleY() { return Math.min(window.innerWidth, window.innerHeight) * 0.26; }
function onDown(e) {
  if (e.target.closest('button, .panel')) return;
  if (touch.active) return;
  touch.active = true; touch.id = e.pointerId;
  touch.ox = touch.x = e.clientX; touch.oy = touch.y = e.clientY;
  stick.style.display = 'block';
  stick.style.left = touch.ox + 'px'; stick.style.top = touch.oy + 'px';
  knob.style.transform = 'translate(-50%,-50%)';
  hideHint();
}
function onMove(e) {
  if (!touch.active || e.pointerId !== touch.id) return;
  touch.x = e.clientX; touch.y = e.clientY;
  const sx = scaleX(), sy = scaleY();
  // floating origin: never let the thumb go "past" full deflection
  let dx = touch.x - touch.ox, dy = touch.y - touch.oy;
  if (dx > sx) touch.ox = touch.x - sx; if (dx < -sx) touch.ox = touch.x + sx;
  if (dy > sy) touch.oy = touch.y - sy; if (dy < -sy) touch.oy = touch.y + sy;
  stick.style.left = touch.ox + 'px'; stick.style.top = touch.oy + 'px';
}
function onUp(e) {
  if (e.pointerId !== touch.id) return;
  touch.active = false; touch.id = -1;
  stick.style.display = 'none';
}
ui.addEventListener('pointerdown', onDown);
window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);
window.addEventListener('pointercancel', onUp);
window.addEventListener('keydown', (e) => { keys.add(e.key.toLowerCase()); if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault(); hideHint(); });
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
document.addEventListener('gesturestart', (e) => e.preventDefault());

let kbSteer = 0;
function readInput(dt) {
  if (touch.active) {
    const sx = scaleX(), sy = scaleY();
    const dx = clamp((touch.x - touch.ox) / sx, -1, 1);
    const dy = clamp((touch.y - touch.oy) / sy, -1, 1);
    input.steer = Math.sign(dx) * Math.pow(Math.abs(dx), 1.15);
    input.pull = Math.abs(dy) < 0.12 ? 0 : (dy - Math.sign(dy) * 0.12) / 0.88;
    knob.style.transform = `translate(calc(-50% + ${dx * 46}px), calc(-50% + ${dy * 46}px))`;
  } else {
    const l = keys.has('arrowleft') || keys.has('a'), r = keys.has('arrowright') || keys.has('d');
    const tgt = (r ? 1 : 0) - (l ? 1 : 0);
    const max = keys.has('shift') ? 0.45 : 1;
    kbSteer += clamp(tgt * max - kbSteer, -2.4 * dt, 2.4 * dt);
    if (!l && !r) kbSteer += clamp(-kbSteer, -4 * dt, 4 * dt);
    input.steer = kbSteer;
    input.pull = (keys.has('arrowdown') || keys.has('s') ? 1 : 0) - (keys.has('arrowup') || keys.has('w') ? 1 : 0);
  }
}

// ------------------------------------------------------------------ HUD
const $ = (id) => document.getElementById(id);
const hud = {
  speed: $('speed'), mode: $('mode'), bar: $('carvebar'), edge: $('edgeval'), edgeSide: $('edgeside'),
  needle: $('needle'), beta: $('beta'), g: $('gval'), rad: $('rad'), surf: $('surf'), msg: $('msg'),
  carvePct: $('carvepct'), dist: $('dist'), top: $('top'),
};
let hint = $('hint');
function hideHint() { if (hint) { hint.classList.add('gone'); hint = null; } }
$('reset').addEventListener('click', () => { rider.reset(); clearTrails(); camInit = false; });
$('helpbtn').addEventListener('click', () => $('help').classList.toggle('show'));
$('help').addEventListener('click', () => $('help').classList.remove('show'));

let shownMode = MODES.stop, pendingMode = null, pendingT = 0, hudT = 0;
function updateHUD(dt) {
  const m = rider.mode;
  if (m !== shownMode) {
    if (m === pendingMode) pendingT += dt; else { pendingMode = m; pendingT = 0; }
    if (pendingT > 0.12 || m === MODES.crash || m === MODES.air) { shownMode = m; pendingMode = null; }
  }
  hudT += dt;
  if (hudT < 1 / 15) return;
  hudT = 0;
  const t = rider.tel;
  hud.speed.textContent = Math.round(t.speed * 3.6);
  hud.mode.textContent = shownMode.label;
  hud.mode.className = 'mode m-' + shownMode.key;
  hud.bar.style.width = Math.round(t.carveQ * 100) + '%';
  const e = rider.edge * D;
  hud.edge.textContent = Math.abs(e).toFixed(0) + '°';
  hud.edgeSide.textContent = Math.abs(e) < 3 ? 'FLAT' : e > 0 ? 'TOE' : 'HEEL';
  hud.needle.style.transform = `rotate(${e}deg)`;
  hud.beta.textContent = (t.betaS * D).toFixed(0) + '°';
  hud.g.textContent = Math.abs(t.latG).toFixed(2) + 'g';
  hud.rad.textContent = isFinite(t.radius) && t.radius < 200 ? t.radius.toFixed(0) + 'm' : '—';
  hud.surf.textContent = t.ice > 0.4 ? '⚠ 冰面' : t.off > 0.5 ? '粉雪/野雪' : '壓雪道';
  const s = rider.stats;
  hud.carvePct.textContent = s.turnDist > 20 ? Math.round(100 * s.carveDist / s.turnDist) + '%' : '—';
  hud.dist.textContent = (s.dist / 1000).toFixed(2) + 'km';
  hud.top.textContent = Math.round(s.maxSpeed * 3.6);
  if (rider.crashT > 0) { hud.msg.textContent = rider.crashReason; hud.msg.classList.add('show'); }
  else hud.msg.classList.remove('show');
}

// ------------------------------------------------------------------ camera
const camPos = new THREE.Vector3(), camDir = new THREE.Vector3(0, 0, 1), camLook = new THREE.Vector3();
let camInit = false, shake = 0;
function updateCamera(dt) {
  const p = rider.p, v = rider.v;
  const hv = new THREE.Vector3(v[0], 0, v[2]);
  const sp = hv.length();
  const want = sp > 2.5 ? hv.normalize() : new THREE.Vector3(rider.f[0], 0, rider.f[2]).normalize();
  // never look back uphill
  const fl = new THREE.Vector3(rider.n[0], 0, rider.n[2]).normalize();
  if (want.dot(fl) < -0.2) want.addScaledVector(fl, 0.6).normalize();
  const k = 1 - Math.exp(-dt * (sp > 2.5 ? 2.6 : 1.2));
  if (!camInit) camDir.copy(want); else camDir.lerp(want, k).normalize();
  const dist = 5.8 + Math.min(2.5, sp * 0.06), hgt = 3.0 + Math.min(1.2, sp * 0.03);
  const target = new THREE.Vector3(p[0], p[1], p[2]).addScaledVector(camDir, -dist);
  target.y = Math.max(p[1] + hgt, height(target.x, target.z) + 1.4);
  if (!camInit) { camPos.copy(target); camInit = true; }
  camPos.lerp(target, 1 - Math.exp(-dt * 7));
  camPos.y = Math.max(camPos.y, height(camPos.x, camPos.z) + 1.2);
  camLook.set(p[0], p[1], p[2]).addScaledVector(camDir, 7);
  camLook.y = 0.5 * (p[1] + 0.9) + 0.5 * (height(camLook.x, camLook.z) + 0.6);
  camera.position.copy(camPos);
  shake += ((rider.tel.skid > 1 && rider.grounded ? Math.min(1, rider.tel.skid / 4) * Math.min(1, sp / 10) : 0) - shake) * Math.min(1, dt * 8);
  if (shake > 0.01) camera.position.add(new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), 0).multiplyScalar(0.05 * shake));
  camera.lookAt(camLook);
  const fov = camera.userData.baseFov + Math.min(12, sp * 0.35);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 2); camera.updateProjectionMatrix(); }
  scene.getObjectByName('sky').position.copy(camera.position);
}

// ------------------------------------------------------------------ rider visuals
const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _l = new THREE.Vector3(), _mat = new THREE.Matrix4();
const visN = new THREE.Vector3(0, 1, 0);
let visEdge = 0, crouchS = 0.3, trailAcc = 0, crashRot = 0;
function updateRiderVisual(dt) {
  const p = rider.p;
  _n.set(rider.n[0], rider.n[1], rider.n[2]);
  if (!rider.grounded) _n.set(0, 1, 0).lerp(_n, 0.5).normalize();
  visN.lerp(_n, 1 - Math.exp(-dt * 12)).normalize();
  _f.set(Math.sin(rider.yaw), 0, Math.cos(rider.yaw));
  _f.addScaledVector(visN, -_f.dot(visN)).normalize();
  _l.crossVectors(visN, _f).normalize(); // rider's left
  _mat.makeBasis(_l, visN, _f);
  riderRoot.quaternion.setFromRotationMatrix(_mat);
  riderRoot.position.set(p[0], p[1], p[2]);

  const crashed = rider.crashT > 0;
  crashRot += ((crashed ? 1 : 0) - crashRot) * Math.min(1, dt * (crashed ? 10 : 4));
  visEdge += (rider.edge - visEdge) * Math.min(1, dt * 20);
  tilt.rotation.z = visEdge * (1 - crashRot) + crashRot * (rider.edge >= 0 ? 1.35 : -1.35);
  tilt.position.y = 0;
  const t = rider.tel;
  const tuck = Math.max(0, -input.pull);
  const crouchT = clamp(0.22 + 0.45 * tuck + 0.18 * Math.min(1.5, Math.abs(t.latG)) + 0.25 * Math.max(0, input.pull) + (rider.grounded ? 0 : 0.35), 0, 1);
  crouchS += (crouchT - crouchS) * Math.min(1, dt * 8);
  // upper body counter-rotates toward travel direction; more twist when pivoting
  const twist = 0.35 + 0.35 * clamp(t.omega * 0.5, -1, 1) * (rider.edge >= 0 ? 1 : -1) * 0.5 + 0.25 * Math.max(0, input.pull);
  poseRider(crouchS, twist, rider.grounded ? 0.25 + 0.3 * Math.min(1, t.skid / 3) : 0.9, tuck * 0.5);

  // shadow
  const gh = height(p[0], p[2]);
  const above = Math.max(0, p[1] - gh);
  shadow.position.set(p[0], gh + 0.03, p[2]);
  shadow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _n.set(rider.n[0], rider.n[1], rider.n[2]));
  const ss = 1.6 + above * 0.3;
  shadow.scale.set(ss, ss * 1.2, 1);
  shadow.material.opacity = 1 / (1 + above * 0.5);

  // trails + spray
  if (rider.grounded && !crashed && t.speed > 1) {
    trailAcc += t.speed * dt;
    if (trailAcc > 0.35) {
      trailAcc = 0;
      const sk = Math.sin(t.betaS);
      const w = 0.07 + 1.35 * sk;
      const q = clamp(t.carveQ, 0, 1);
      const col = q > 0.5 && sk < 0.1 ? [0.50, 0.60, 0.78] : [0.80 - 0.1 * q, 0.85 - 0.08 * q, 0.95];
      addTrail(w, col);
    }
  } else trPrev = null;

  if (rider.grounded && !crashed && t.speed > 2) {
    const n = rider.n, r = rider.r, eS = Math.sign(rider.edge) || 1;
    const skid = t.skid;
    let rate = 0, dir, spread, upv;
    if (skid > 0.5) {
      rate = Math.min(260, skid * t.speed * 4);
      const vrs = Math.sign(rider.v[0] * r[0] + rider.v[1] * r[1] + rider.v[2] * r[2]) || 1;
      dir = [r[0] * vrs, 0, r[2] * vrs]; spread = 1.2 + Math.min(4, skid * 0.5); upv = 1.3 + Math.min(1.6, skid * 0.25);
    } else if (shownMode === MODES.carve) {
      rate = Math.min(140, t.speed * 3.5 * Math.min(1, Math.abs(t.latG)));
      dir = [-r[0] * eS, 0, -r[2] * eS]; spread = 1.2; upv = 1.4;
    }
    if (rate > 0) {
      spAcc += rate * dt;
      const c = Math.floor(spAcc); spAcc -= c;
      const tail = [p[0] - rider.f[0] * 0.5 + n[0] * 0.05, p[1] + 0.05, p[2] - rider.f[2] * 0.5];
      emitSpray(c, tail, dir, spread, upv, [rider.v[0] * 0.6, 0, rider.v[2] * 0.6]);
    }
  }
}

// ------------------------------------------------------------------ main loop
rebuildTerrain(rider.p[0], rider.p[2]);
let last = performance.now(), acc = 0, paused = false;
document.addEventListener('visibilitychange', () => { paused = document.hidden; last = performance.now(); });

function frame(now) {
  requestAnimationFrame(frame);
  if (paused) return;
  let dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  readInput(dt);
  acc += dt;
  let steps = 0;
  while (acc >= PHYS_DT && steps < 12) { rider.step(PHYS_DT, input); acc -= PHYS_DT; steps++; }
  if (steps === 12) acc = 0;
  if (Math.hypot(rider.p[0] - terrainCenter.x, rider.p[2] - terrainCenter.z) > 18) rebuildTerrain(rider.p[0], rider.p[2]);
  updateRiderVisual(dt);
  updateSpray(dt);
  updateCamera(dt);
  updateSnowfall(dt);
  for (const [c, a, b] of snowCopies) c.position.set(snowfall.position.x + a * SNB, snowfall.position.y, snowfall.position.z + b * SNB);
  updateHUD(dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// expose for debugging / automated play-testing
window.__game = { rider, input, keys };
