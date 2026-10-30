// Procedural riders. Snowboarder and skier share the same rig ideas:
// tapered limb segments + joint spheres placed by two-bone IK each frame.
// Local frame: +Z = board nose / ski tips, +Y = up, +X = rider's LEFT.
// A snowboarder (regular) faces -X (toeside); a skier faces +Z.
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

// ---------------------------------------------------------------- shared textures
let fabricNormal = null;
function fabricNormalMap() {
  if (fabricNormal) return fabricNormal;
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'); const img = g.createImageData(S, S);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // woven ripstop + soft wrinkles
    const weave = ((x % 6 < 1) || (y % 6 < 1)) ? 0.6 : 0;
    const wr = Math.sin(y * 0.19 + Math.sin(x * 0.07) * 3) * 1.4;
    h[y * S + x] = weave + wr + Math.random() * 0.25;
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
    const dy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
    let nx = -dx * 0.5, ny = -dy * 0.5, nz = 1; const l = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  fabricNormal = new THREE.CanvasTexture(c);
  fabricNormal.wrapS = fabricNormal.wrapT = THREE.RepeatWrapping;
  fabricNormal.repeat.set(3, 3);
  return fabricNormal;
}
function goggleTexture(tint) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 32;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 32);
  gr.addColorStop(0, tint[0]); gr.addColorStop(0.5, tint[1]); gr.addColorStop(1, tint[2]);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 32);
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(10, 6, 40, 3);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function fabric(color, rough = 0.85) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, normalMap: fabricNormalMap(), normalScale: new THREE.Vector2(0.35, 0.35) });
}
const std = (color, rough = 0.6, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...extra });

// ---------------------------------------------------------------- rig helpers
function seg(parent, mat, r0, r1, segs = 10) {
  // unit-height tapered cylinder along +Y from 0..1 (r0 at bottom/start, r1 at top/end)
  const g = new THREE.CylinderGeometry(r1, r0, 1, segs, 1, true); g.translate(0, 0.5, 0);
  const m = new THREE.Mesh(g, mat); m.castShadow = true; parent.add(m); return m;
}
function ball(parent, mat, r, segs = 12) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, segs, Math.max(6, segs * 0.6 | 0)), mat); m.castShadow = true; parent.add(m); return m;
}
const _d = new THREE.Vector3();
function placeSeg(m, a, b) {
  _d.subVectors(b, a);
  const len = _d.length();
  m.position.copy(a);
  m.scale.set(1, Math.max(0.01, len), 1);
  m.quaternion.setFromUnitVectors(UP, _d.normalize());
}
function ik(a, c, l1, l2, hint) {
  const ac = new THREE.Vector3().subVectors(c, a);
  const d = Math.max(0.05, Math.min(ac.length(), l1 + l2 - 1e-3));
  const dir = ac.normalize();
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const pole = hint.clone().sub(dir.clone().multiplyScalar(hint.dot(dir))).normalize();
  return a.clone().addScaledVector(dir, x).addScaledVector(pole, h);
}

// torso: lathe profile (hips -> waist -> chest -> shoulders), squashed front-to-back
function torsoGeometry(len) {
  const pts = [
    [0.0, -0.09], [0.165, -0.08], [0.175, 0.0], [0.162, 0.12], [0.178, 0.26], [0.19, 0.36], [0.17, 0.43], [0.09, 0.47], [0.0, 0.48],
  ].map(([r, y]) => new THREE.Vector2(r, y * len / 0.48));
  const g = new THREE.LatheGeometry(pts, 18);
  g.scale(0.78, 1, 1.12);
  return g;
}

// ---------------------------------------------------------------- equipment
function boardGeometry() {
  const L = 1.56, half = L / 2, tipR = 0.15, waist = 0.124, contact = 0.6;
  const hw = (z) => {
    const az = Math.abs(z);
    if (az <= contact) { const t = z / contact; return waist + (tipR - waist) * t * t; }
    const u = Math.min(1, (az - contact) / (half - contact));
    return tipR * Math.sqrt(Math.max(0, 1 - u * u));
  };
  const s = new THREE.Shape();
  const N = 60, pts = [];
  for (let i = 0; i <= N; i++) { const z = -half + (2 * half * i) / N; pts.push([hw(z), z]); }
  for (let i = N; i >= 0; i--) { const z = -half + (2 * half * i) / N; pts.push([-hw(z), z]); }
  s.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) s.lineTo(p[0], p[1]);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.006, bevelSegments: 1, curveSegments: 4 });
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.02, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = Math.max(0, Math.abs(p.getZ(i)) - contact);
    p.setY(i, p.getY(i) + k * k * 2.6);
  }
  g.computeVertexNormals();
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / 0.32 + 0.5; uv[i * 2 + 1] = p.getZ(i) / L + 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
function boardTexture(c1, c2, accent) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 512;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, c1); gr.addColorStop(0.5, c2); gr.addColorStop(1, c1);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 512);
  g.fillStyle = accent;
  for (let i = 0; i < 7; i++) { g.save(); g.translate(32, 120 + i * 40); g.rotate(-0.5); g.fillRect(-60, -5, 120, 10 - i); g.restore(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function skiGeometry() {
  const g = new THREE.BoxGeometry(0.085, 0.02, 1.7, 1, 1, 20);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const k = Math.max(0, z - 0.62), kt = Math.max(0, -z - 0.7);
    p.setY(i, p.getY(i) + k * k * 2.2 + kt * kt * 1.2);
    const w = 1 + 0.18 * (Math.abs(z) / 0.85) ** 2; // sidecut
    p.setX(i, p.getX(i) * w);
  }
  g.computeVertexNormals();
  g.translate(0, 0.012, 0);
  return g;
}

export const OUTFITS = [
  { jacket: 0xff5a1f, yoke: 0x1d2a3d, pants: 0x2e3a2f, helmet: 0xf2f4f7, gog: ['#ff9a3c', '#c2185b', '#3a1d6b'], board: ['#0f1c2e', '#173a5e', '#ff6a2b'] },
  { jacket: 0x2a7de1, yoke: 0xf1f1f1, pants: 0x1c1f26, helmet: 0x20242b, gog: ['#7af0ff', '#2a6cff', '#14205a'], board: ['#f5f2ea', '#e8e1cf', '#2a7de1'] },
  { jacket: 0xf2d33b, yoke: 0x262a31, pants: 0x3d4f6b, helmet: 0xffffff, gog: ['#ffd36a', '#ff6a2b', '#5b1a0e'], board: ['#1a1a1a', '#333', '#f2d33b'] },
  { jacket: 0x7b3fb5, yoke: 0xe9e4f2, pants: 0x2b2b30, helmet: 0xc9ced6, gog: ['#c9f7ff', '#46b3ff', '#123a6b'], board: ['#2b1745', '#4b2a7a', '#9fe870'] },
  { jacket: 0x2f9e6b, yoke: 0x1b2a22, pants: 0xb9b2a3, helmet: 0x2f3542, gog: ['#ffe9a8', '#ffa94d', '#7a3a00'], board: ['#103a2a', '#1d5c43', '#ffffff'] },
  { jacket: 0xe8e8ea, yoke: 0xd6333f, pants: 0xd6333f, helmet: 0xd6333f, gog: ['#ffefb3', '#ff8a3d', '#6b1d1d'], board: ['#d6333f', '#f2f2f2', '#111'] },
];

// ---------------------------------------------------------------- body (shared)
function buildBody(lean, outfit, lod) {
  const seg10 = lod ? 7 : 12;
  const M = {
    jacket: fabric(outfit.jacket, 0.8), yoke: fabric(outfit.yoke, 0.8), pants: fabric(outfit.pants, 0.9),
    dark: std(0x17191e, 0.65), helmet: std(outfit.helmet, 0.3), gaiter: fabric(0x24272e, 0.95),
    gog: new THREE.MeshStandardMaterial({ map: goggleTexture(outfit.gog), roughness: 0.08, metalness: 0.5, emissive: 0xffffff, emissiveMap: goggleTexture(outfit.gog), emissiveIntensity: 0.25 }),
  };
  const P = {};
  // legs
  for (const s of ['L', 'R']) {
    P['thigh' + s] = seg(lean, M.pants, 0.078, 0.092, seg10);
    P['knee' + s] = ball(lean, M.pants, 0.08, seg10);
    P['shin' + s] = seg(lean, M.pants, 0.07, 0.076, seg10);
    P['cuff' + s] = seg(lean, M.pants, 0.095, 0.075, seg10); // pant flare over the boot
    P['hip' + s] = ball(lean, M.pants, 0.092, seg10);
    P['sh' + s] = ball(lean, M.jacket, 0.075, seg10);
    P['uarm' + s] = seg(lean, M.jacket, 0.058, 0.07, seg10);
    P['elbow' + s] = ball(lean, M.jacket, 0.058, seg10);
    P['farm' + s] = seg(lean, M.jacket, 0.052, 0.058, seg10);
    P['cuffA' + s] = seg(lean, M.dark, 0.058, 0.05, seg10);
    const glove = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8).scale(0.85, 1.25, 0.65), M.dark); palm.castShadow = true;
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.04, 3, 6), M.dark); thumb.position.set(0.045, 0.01, 0.02); thumb.rotation.z = -0.6;
    glove.add(palm, thumb); lean.add(glove); P['glove' + s] = glove;
  }
  P.pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.17, seg10, 10).scale(0.8, 0.6, 1.1), M.pants); P.pelvis.castShadow = true; lean.add(P.pelvis);
  // torso with jacket details
  P.torso = new THREE.Mesh(torsoGeometry(0.56), M.jacket); P.torso.castShadow = true; lean.add(P.torso);
  const yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.185, 0.12, 18, 1, true).scale(0.8, 1, 1.13), M.yoke); yoke.position.y = 0.4; P.torso.add(yoke);
  const hem = new THREE.Mesh(new THREE.TorusGeometry(0.168, 0.018, 6, 20).scale(0.8, 1.13, 1), M.yoke); hem.rotation.x = Math.PI / 2; hem.position.y = -0.08; P.torso.add(hem);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 14, 1, true), M.jacket); collar.material = M.jacket; collar.position.y = 0.52; P.torso.add(collar);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6).scale(1, 0.7, 1.2), M.jacket); hood.position.set(0.11, 0.5, 0); hood.rotation.z = -1.1; P.torso.add(hood);
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.32, 0.26), M.dark); pack.position.set(0.17, 0.25, 0); P.torso.add(pack);
  const zip = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.46, 0.014), M.dark); zip.position.set(-0.14, 0.2, 0); P.torso.add(zip);
  for (const z of [-0.12, 0.12]) { const pk = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.1, 0.09), M.yoke); pk.position.set(-0.137, 0.08, z); P.torso.add(pk); }
  // head: helmet with vents, goggles, neck gaiter
  const head = new THREE.Group(); P.head = head; lean.add(head);
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.135, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62).scale(1.08, 1.05, 0.98), M.helmet); helm.castShadow = true; helm.position.y = 0.005;
  for (let i = -2; i <= 2; i++) { const v = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.012, 0.012), M.dark); v.position.set(0.0, 0.135, i * 0.035); v.rotation.z = 0.1; head.add(v); }
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 10), M.gaiter); skull.position.y = -0.02;
  const gog = new THREE.Mesh(new THREE.CylinderGeometry(0.133, 0.128, 0.075, 20, 1, true, Math.PI * 0.62, Math.PI * 0.76).scale(1.02, 1, 0.98), M.gog);
  gog.material.side = THREE.DoubleSide; gog.position.y = -0.005;
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.131, 0.012, 6, 28, Math.PI * 0.8), M.dark); frame.rotation.x = Math.PI / 2; frame.rotation.z = Math.PI * 0.6; frame.position.y = -0.005;
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.134, 0.014, 6, 28), std(0x30343c, 0.8)); strap.rotation.x = Math.PI / 2; strap.position.y = 0.0;
  const gaiter = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.16, 14), M.gaiter); gaiter.position.y = -0.12;
  head.add(helm, skull, gog, frame, strap, gaiter);
  return { P, M };
}

// ---------------------------------------------------------------- snowboarder
export function createRiderModel(opts = {}) {
  const outfit = opts.outfit || OUTFITS[0];
  const lod = !!opts.lod;
  const root = new THREE.Group();
  const boardTilt = new THREE.Group();
  const lean = new THREE.Group();
  root.add(boardTilt, lean);
  const { P, M } = buildBody(lean, outfit, lod);
  const bt = boardTexture(...outfit.board);
  const board = new THREE.Mesh(boardGeometry(), [new THREE.MeshStandardMaterial({ map: bt, roughness: 0.35 }), std(0x101215, 0.5)]);
  board.castShadow = true; boardTilt.add(board);
  for (const z of [0.25, -0.25]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.26), M.dark); base.position.set(0, 0.04, z);
    const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.1, 0.22, 10, 1, true, Math.PI * 0.15, Math.PI * 0.7), std(0x17191e, 0.5, { side: THREE.DoubleSide }));
    hb.position.set(0.06, 0.15, z); hb.rotation.y = Math.PI / 2; hb.rotation.z = 0.15;
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.24), std(0x2b2f36, 0.6)); strap.position.set(-0.04, 0.16, z);
    base.castShadow = hb.castShadow = true;
    boardTilt.add(base, hb, strap);
  }
  const boots = ['L', 'R'].map(() => {
    const b = new THREE.Group();
    const sh = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.17, 4, 10), M.dark); sh.rotation.z = Math.PI / 2; sh.position.y = 0.05; sh.scale.set(1, 1, 1.25);
    const up = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.16, 10), M.dark); up.position.set(0.02, 0.13, 0);
    sh.castShadow = up.castShadow = true;
    b.add(sh, up); lean.add(b); return b;
  });

  const tmp = { q: new THREE.Quaternion(), e: new THREE.Euler() };
  function pose(s) {
    boardTilt.rotation.z = s.edge;
    lean.rotation.z = s.lean;
    const rel = s.edge - s.lean;
    const c = Math.cos(rel), sn = Math.sin(rel);
    const feet = [V(0, 0.1, 0.25), V(0, 0.1, -0.25)].map((f) => V(f.x * c - f.y * sn, f.x * sn + f.y * c, f.z));
    const bob = Math.sin(s.t * 2.1) * 0.006;
    const hipY = 0.93 - 0.36 * s.crouch + bob;
    const hipX = 0.04 - 0.08 * s.crouch + s.fore * 0.1;
    const hipC = V(hipX, hipY, 0);
    const legs = ['L', 'R'];
    for (let i = 0; i < 2; i++) {
      const L = legs[i];
      const hip = V(hipX, hipY, i === 0 ? 0.1 : -0.1);
      const ankle = feet[i].clone().add(V(0, 0.1, 0));
      const knee = ik(hip, ankle, 0.45, 0.43, V(-1, 0.1, i === 0 ? 0.35 : -0.35));
      placeSeg(P['thigh' + L], hip, knee);
      P['knee' + L].position.copy(knee);
      P['hip' + L].position.copy(hip);
      placeSeg(P['shin' + L], knee, ankle);
      const cuffTop = ankle.clone().lerp(knee, 0.28);
      placeSeg(P['cuff' + L], ankle.clone().add(V(0, -0.02, 0)), cuffTop);
      boots[i].position.copy(feet[i]).add(V(-0.02, -0.04, 0));
      boots[i].rotation.set(0, 0, rel);
    }
    P.pelvis.position.copy(hipC).add(V(0.01, 0.05, 0));
    const bend = 0.12 + 0.42 * s.crouch - s.fore * 0.2 - Math.max(0, s.lean) * 0.55 + Math.max(0, -s.lean) * 0.15;
    const ang = -s.lean * 0.35 * (1 - s.crash);
    tmp.e.set(ang, s.twist, bend, 'YXZ'); tmp.q.setFromEuler(tmp.e);
    const spine = V(0, 1, 0).applyQuaternion(tmp.q);
    const tBase = hipC.clone().add(V(0, 0.08, 0));
    P.torso.position.copy(tBase);
    P.torso.quaternion.copy(tmp.q);
    const neck = tBase.clone().addScaledVector(spine, 0.5);
    P.head.position.copy(neck).addScaledVector(spine, 0.13);
    P.head.quaternion.setFromEuler(new THREE.Euler(-ang * 0.5, s.twist * 0.6 + 1.05, bend * 0.25, 'YXZ'));
    const side = V(0, 0, 1).applyQuaternion(tmp.q);
    for (const [L, sg] of [['L', 1], ['R', -1]]) {
      const sh = neck.clone().addScaledVector(spine, -0.08).addScaledVector(side, 0.2 * sg);
      let hand;
      if (s.drag > 0.01 && sg > 0) hand = sh.clone().add(V(-0.28 - 0.25 * s.drag, -0.62 * s.drag - 0.15, 0.25 * s.drag));
      else if (s.grab > 0.05 && sg < 0) {
        // grab: rear hand reaches down to the toe edge between the bindings
        const rel2 = s.edge - s.lean, c2 = Math.cos(rel2), sn2 = Math.sin(rel2);
        const target = V(-0.14 * c2 - 0.06 * sn2, -0.14 * sn2 + 0.06 * c2, -0.02);
        hand = sh.clone().lerp(target, s.grab);
        hand.y = Math.max(hand.y, 0.08);
      }
      else {
        const out = 0.22 + 0.32 * s.arms;
        const sway = Math.sin(s.t * 1.7 + sg) * 0.02;
        hand = sh.clone().add(V(-0.2 - 0.1 * s.crouch, -0.42 + 0.3 * s.arms + 0.25 * s.air + sway, sg * out));
        if (s.grab > 0.05) hand.add(V(0, 0.25 * s.grab, sg * 0.15 * s.grab)); // free arm out for style
      }
      if (s.crash > 0.5) hand = sh.clone().add(V(-0.1, 0.25, sg * 0.45));
      const elbow = ik(sh, hand, 0.29, 0.28, V(0.4, -0.5, sg * 0.8));
      P['sh' + L].position.copy(sh);
      placeSeg(P['uarm' + L], sh, elbow);
      P['elbow' + L].position.copy(elbow);
      const wrist = elbow.clone().lerp(hand, 0.82);
      placeSeg(P['farm' + L], elbow, wrist);
      placeSeg(P['cuffA' + L], wrist, hand);
      P['glove' + L].position.copy(hand);
      P['glove' + L].quaternion.setFromUnitVectors(UP, hand.clone().sub(elbow).normalize());
    }
  }
  pose({ edge: 0, lean: 0, crouch: 0.3, twist: 0.5, arms: 0.3, drag: 0, crash: 0, air: 0, fore: 0, t: 0, grab: 0 });
  return { root, pose, kind: 'board' };
}

// ---------------------------------------------------------------- skier
export function createSkierModel(opts = {}) {
  const outfit = opts.outfit || OUTFITS[1];
  const lod = !!opts.lod;
  const root = new THREE.Group();
  const skiTilt = new THREE.Group();
  const lean = new THREE.Group();
  root.add(skiTilt, lean);
  const { P, M } = buildBody(lean, outfit, lod);
  const skiMat = new THREE.MeshStandardMaterial({ map: boardTexture(...outfit.board), roughness: 0.35 });
  const skis = [0.11, -0.11].map((x) => {
    const s = new THREE.Mesh(skiGeometry(), skiMat); s.position.x = x; s.castShadow = true; skiTilt.add(s);
    const bind = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.3), M.dark); bind.position.set(x, 0.04, 0); skiTilt.add(bind);
    return s;
  });
  const boots = [0, 1].map(() => {
    const b = new THREE.Group();
    const sh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.3), M.dark); sh.position.y = 0.06;
    const up = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.24, 10), M.dark); up.position.set(0, 0.2, -0.02); up.rotation.x = 0.25;
    sh.castShadow = up.castShadow = true;
    b.add(sh, up); lean.add(b); return b;
  });
  const poleMat = std(0x9aa3ad, 0.3, { metalness: 0.6 });
  const poles = [0, 1].map(() => { const p = seg(lean, poleMat, 0.009, 0.011, 6); const bask = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.006, 4, 10), M.dark); bask.rotation.x = Math.PI / 2; lean.add(bask); p.userData.b = bask; return p; });
  const tmp = { q: new THREE.Quaternion(), e: new THREE.Euler() };
  function pose(s) {
    skiTilt.rotation.z = s.edge;
    lean.rotation.z = s.lean;
    const rel = s.edge - s.lean;
    const c = Math.cos(rel), sn = Math.sin(rel);
    const feet = [V(0.11, 0.06, 0), V(-0.11, 0.06, 0)].map((f) => V(f.x * c - f.y * sn, f.x * sn + f.y * c, f.z + (f.x * s.lean > 0 ? 0.08 : -0.02)));
    const bob = Math.sin(s.t * 2.3) * 0.006;
    const hipY = 0.95 - 0.33 * s.crouch + bob;
    const hipC = V(0, hipY, -0.1 - 0.08 * s.crouch);
    for (let i = 0; i < 2; i++) {
      const L = i === 0 ? 'L' : 'R';
      const hip = hipC.clone().add(V(i === 0 ? 0.1 : -0.1, 0, 0));
      const ankle = feet[i].clone().add(V(0, 0.12, 0));
      const knee = ik(hip, ankle, 0.45, 0.43, V(i === 0 ? 0.08 : -0.08, 0.1, 1));
      placeSeg(P['thigh' + L], hip, knee); P['knee' + L].position.copy(knee); P['hip' + L].position.copy(hip);
      placeSeg(P['shin' + L], knee, ankle);
      placeSeg(P['cuff' + L], ankle.clone().add(V(0, 0.02, 0)), ankle.clone().lerp(knee, 0.3));
      boots[i].position.copy(feet[i]).add(V(0, -0.04, 0)); boots[i].rotation.set(0, 0, rel);
    }
    P.pelvis.position.copy(hipC).add(V(0, 0.05, 0));
    P.pelvis.rotation.y = Math.PI / 2;
    const bend = 0.35 + 0.4 * s.crouch;
    const ang = -s.lean * 0.4 * (1 - s.crash);
    // skier faces +Z: rotate torso so its front (-X in torso space) points +Z
    tmp.e.set(0, Math.PI / 2 + s.twist * 0.3, 0, 'YXZ'); tmp.q.setFromEuler(tmp.e);
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(bend, 0, ang, 'XYZ'));
    const q = tilt.multiply(tmp.q);
    const spine = V(0, 1, 0).applyQuaternion(q);
    const tBase = hipC.clone().add(V(0, 0.08, 0));
    P.torso.position.copy(tBase); P.torso.quaternion.copy(q);
    const neck = tBase.clone().addScaledVector(spine, 0.5);
    P.head.position.copy(neck).addScaledVector(spine, 0.13);
    P.head.quaternion.copy(new THREE.Quaternion().setFromEuler(new THREE.Euler(-bend * 0.6, 0, ang * 0.5, 'XYZ')).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0))));
    const side = V(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, ang)));
    for (const [i, L, sg] of [[0, 'L', 1], [1, 'R', -1]]) {
      const sh = neck.clone().addScaledVector(spine, -0.08).addScaledVector(side, 0.2 * sg);
      const plant = Math.max(0, Math.sin(s.t * 2.2 + i * Math.PI)) * 0.12 * s.arms;
      const hand = sh.clone().add(V(sg * 0.18, -0.38 + 0.08 * s.arms, 0.32 + plant));
      if (s.crash > 0.5) hand.add(V(sg * 0.2, 0.4, -0.2));
      const elbow = ik(sh, hand, 0.29, 0.28, V(sg * 0.6, -0.4, -0.5));
      P['sh' + L].position.copy(sh);
      placeSeg(P['uarm' + L], sh, elbow); P['elbow' + L].position.copy(elbow);
      const wrist = elbow.clone().lerp(hand, 0.82);
      placeSeg(P['farm' + L], elbow, wrist); placeSeg(P['cuffA' + L], wrist, hand);
      P['glove' + L].position.copy(hand);
      // pole from the hand down and back to the snow
      const tip = hand.clone().add(V(sg * 0.12, -hand.y + 0.05, -0.55 + plant));
      placeSeg(poles[i], hand, tip);
      poles[i].userData.b.position.copy(tip).add(V(0, 0.1, 0));
    }
  }
  pose({ edge: 0, lean: 0, crouch: 0.3, twist: 0, arms: 0.3, drag: 0, crash: 0, air: 0, fore: 0, t: 0 });
  return { root, pose, kind: 'ski' };
}
