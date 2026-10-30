// Procedural snowboarder: shaped board with sidecut, bindings, and a jointed rider
// posed with simple two-bone IK. Local frame: +Z = board nose, +Y = up, +X = rider's LEFT
// (regular stance, rider faces -X = toeside).
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

function std(color, rough = 0.7, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...extra });
}

function boardGeometry() {
  // outline in the XZ plane with a real sidecut (waist narrower than nose/tail)
  const L = 1.56, half = L / 2, tipR = 0.15, waist = 0.124, contact = 0.6;
  const s = new THREE.Shape();
  const hw = (z) => {
    const az = Math.abs(z);
    if (az <= contact) { const t = z / contact; return waist + (tipR - waist) * t * t; }
    const u = Math.min(1, (az - contact) / (half - contact));
    return tipR * Math.sqrt(Math.max(0, 1 - u * u));
  };
  const pts = [];
  const N = 60;
  for (let i = 0; i <= N; i++) { const z = -half + (2 * half * i) / N; pts.push([hw(z), z]); }
  for (let i = N; i >= 0; i--) { const z = -half + (2 * half * i) / N; pts.push([-hw(z), z]); }
  s.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) s.lineTo(p[0], p[1]);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.016, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.006, bevelSegments: 1, curveSegments: 4 });
  g.rotateX(Math.PI / 2); // shape XY -> XZ, extrude goes -Y
  g.translate(0, 0.02, 0);
  // kick the nose and tail up
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const k = Math.max(0, Math.abs(z) - contact);
    p.setY(i, p.getY(i) + k * k * 2.6);
  }
  g.computeVertexNormals();
  // planar UVs for the top graphic
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / 0.32 + 0.5; uv[i * 2 + 1] = p.getZ(i) / L + 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
function boardTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 512;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 512);
  gr.addColorStop(0, '#0f1c2e'); gr.addColorStop(0.5, '#173a5e'); gr.addColorStop(1, '#0f1c2e');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 512);
  g.fillStyle = '#ff6a2b';
  for (let i = 0; i < 7; i++) { g.save(); g.translate(32, 120 + i * 40); g.rotate(-0.5); g.fillRect(-60, -5, 120, 10 - i); g.restore(); }
  g.fillStyle = '#e8f3ff'; g.font = 'bold 30px sans-serif'; g.save(); g.translate(40, 470); g.rotate(-Math.PI / 2); g.fillText('CARVE', 0, 0); g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function capsuleBetween(mat, r) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, 1, 4, 10), mat);
  m.castShadow = true;
  m.userData.r = r;
  return m;
}
function place(m, a, b) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  m.position.copy(a).addScaledVector(d, 0.5);
  m.scale.set(1, Math.max(0.01, len), 1);
  // CapsuleGeometry length 1 + caps: scale only the cylinder part approximately
  m.scale.y = Math.max(0.05, len / (1 + m.userData.r * 2)) ;
  m.quaternion.setFromUnitVectors(UP, d.normalize());
}
// two-bone IK: returns the middle joint for root a, target c, lengths l1, l2, bend hint
function ik(a, c, l1, l2, hint) {
  const ac = new THREE.Vector3().subVectors(c, a);
  let d = ac.length();
  d = Math.min(d, l1 + l2 - 1e-3);
  const dir = ac.clone().normalize();
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const pole = hint.clone().sub(dir.clone().multiplyScalar(hint.dot(dir))).normalize();
  return a.clone().addScaledVector(dir, x).addScaledVector(pole, h);
}

export function createRiderModel() {
  const root = new THREE.Group();
  const boardTilt = new THREE.Group();   // rolls with edge angle
  const lean = new THREE.Group();        // body inclination (balance)
  root.add(boardTilt, lean);

  const jacket = std(0xff5a1f, 0.75), jacket2 = std(0x1d2a3d, 0.8), pants = std(0x2e3a2f, 0.85);
  const dark = std(0x15181d, 0.6), helmetM = std(0xf2f4f7, 0.35), skin = std(0xd9a383, 0.7);
  const gogM = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1, metalness: 0.6, emissive: 0x3a1d6b, emissiveIntensity: 0.35 });

  // ---- board + bindings
  const board = new THREE.Mesh(boardGeometry(), [new THREE.MeshStandardMaterial({ map: boardTexture(), roughness: 0.35 }), std(0x101215, 0.5)]);
  board.castShadow = true;
  boardTilt.add(board);
  for (const z of [0.25, -0.25]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.26), dark); base.position.set(0, 0.04, z);
    const hb = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.1, 0.2, 10, 1, true, Math.PI * 0.15, Math.PI * 0.7), dark);
    hb.material = dark.clone(); hb.material.side = THREE.DoubleSide;
    hb.position.set(0.06, 0.15, z); hb.rotation.y = Math.PI / 2; hb.rotation.z = 0.15;
    base.castShadow = hb.castShadow = true;
    boardTilt.add(base, hb);
  }

  // ---- body parts (live in `lean`)
  const P = {};
  const add = (k, m) => { P[k] = m; m.castShadow = true; lean.add(m); return m; };
  add('thighL', capsuleBetween(pants, 0.085)); add('thighR', capsuleBetween(pants, 0.085));
  add('shinL', capsuleBetween(pants, 0.075)); add('shinR', capsuleBetween(pants, 0.075));
  add('bootL', new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.14), dark));
  add('bootR', new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.14), dark));
  add('pelvis', new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.16, 4, 10), pants));
  P.pelvis.rotation.x = Math.PI / 2;
  const torsoG = new THREE.CapsuleGeometry(0.165, 0.3, 4, 12); torsoG.scale(0.82, 1, 1.12);
  add('torso', new THREE.Mesh(torsoG, jacket));
  const yoke = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.12, 4, 12).scale(0.84, 0.6, 1.14), jacket2); yoke.position.y = 0.16; P.torso.add(yoke);
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), jacket); hood.position.set(0.13, 0.22, 0); hood.rotation.z = -0.9; P.torso.add(hood);
  const zip = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.42, 0.012), dark); zip.position.set(-0.137, 0, 0); P.torso.add(zip);
  add('uArmL', capsuleBetween(jacket, 0.06)); add('uArmR', capsuleBetween(jacket, 0.06));
  add('fArmL', capsuleBetween(jacket, 0.055)); add('fArmR', capsuleBetween(jacket, 0.055));
  add('gloveL', new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8).scale(1, 0.85, 1.25), dark));
  add('gloveR', new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8).scale(1, 0.85, 1.25), dark));
  const head = new THREE.Group(); P.head = head; lean.add(head);
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 12).scale(1.05, 1, 0.95), helmetM); helm.castShadow = true; helm.position.y = 0.03;
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.105, 14, 10), skin); face.position.set(-0.03, -0.03, 0);
  const gog = new THREE.Mesh(new THREE.CylinderGeometry(0.128, 0.128, 0.07, 18, 1, true, Math.PI * 0.7, Math.PI * 0.6), gogM);
  gog.material.side = THREE.DoubleSide; gog.position.set(0, 0.01, 0);
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.128, 0.012, 6, 24), dark); strap.rotation.x = Math.PI / 2; strap.position.y = 0.01;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.12, 10), jacket2); neck.position.y = -0.14;
  head.add(helm, face, gog, strap, neck);

  const state = { crouch: 0.3, lean: 0, edge: 0, twist: 0.3, arms: 0.3, crash: 0, drag: 0, air: 0, fore: 0 };

  function pose(s) {
    // ---- board
    boardTilt.rotation.z = s.edge;
    lean.rotation.z = s.lean;
    // ---- feet in lean space: rotate board foot points by (edge - lean)
    const rel = s.edge - s.lean;
    const footBoard = [V(0, 0.09, 0.25), V(0, 0.09, -0.25)];
    const feet = footBoard.map((f) => {
      const c = Math.cos(rel), sn = Math.sin(rel);
      return V(f.x * c - f.y * sn, f.x * sn + f.y * c, f.z);
    });
    const hipY = 0.95 - 0.36 * s.crouch;
    const hipX = 0.04 - 0.08 * s.crouch + s.fore * 0.1;      // knees go toward -X (toes)
    const hipC = V(hipX, hipY, 0);
    const hips = [V(hipX, hipY, 0.1), V(hipX, hipY, -0.1)];
    const keys = [['thighL', 'shinL', 'bootL'], ['thighR', 'shinR', 'bootR']];
    for (let i = 0; i < 2; i++) {
      const knee = ik(hips[i], feet[i], 0.46, 0.46, V(-1, 0.1, i === 0 ? 0.35 : -0.35));
      place(P[keys[i][0]], hips[i], knee);
      place(P[keys[i][1]], knee, feet[i].clone().add(V(0, 0.05, 0)));
      P[keys[i][2]].position.copy(feet[i]).add(V(-0.03, 0.0, 0));
      P[keys[i][2]].rotation.set(0, 0, rel);
    }
    P.pelvis.position.copy(hipC).add(V(0.01, 0.04, 0));
    // ---- torso: leans forward with crouch, upright-ish against the lean (angulation)
    const bend = 0.12 + 0.42 * s.crouch - s.fore * 0.2 - Math.max(0, s.lean) * 0.55 + Math.max(0, -s.lean) * 0.15;
    const ang = -s.lean * 0.35 * (1 - s.crash);
    const tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(ang, s.twist, bend, 'YXZ'));
    const spineDir = V(0, 1, 0).applyQuaternion(tq);
    const tBase = hipC.clone().add(V(0, 0.1, 0));
    P.torso.position.copy(tBase).addScaledVector(spineDir, 0.26);
    P.torso.quaternion.copy(tq);
    const neckP = tBase.clone().addScaledVector(spineDir, 0.55);
    P.head.position.copy(neckP).addScaledVector(spineDir, 0.14);
    // head looks toward the nose / travel direction
    P.head.quaternion.setFromEuler(new THREE.Euler(-ang * 0.5, s.twist * 0.6 + 1.05, bend * 0.25, 'YXZ'));
    // ---- arms
    const side = V(0, 0, 1).applyQuaternion(tq);
    for (const [i, sg] of [[0, 1], [1, -1]]) {
      const sh = neckP.clone().addScaledVector(spineDir, -0.08).addScaledVector(side, 0.21 * sg);
      let hand;
      if (s.drag > 0.01 && sg < 0 === false) {
        // toeside euro-carve: front hand reaches down to the snow
        hand = sh.clone().add(V(-0.28 - 0.25 * s.drag, -0.62 * s.drag - 0.15, 0.25 * s.drag));
      } else {
        const out = 0.24 + 0.32 * s.arms;
        hand = sh.clone().add(V(-0.2 - 0.1 * s.crouch, -0.42 + 0.3 * s.arms + 0.25 * s.air, sg * out));
      }
      if (s.crash > 0.5) hand = sh.clone().add(V(-0.1, 0.25, sg * 0.45));
      const elbow = ik(sh, hand, 0.3, 0.3, V(0.4, -0.5, sg * 0.8));
      place(P[i === 0 ? 'uArmL' : 'uArmR'], sh, elbow);
      place(P[i === 0 ? 'fArmL' : 'fArmR'], elbow, hand);
      P[i === 0 ? 'gloveL' : 'gloveR'].position.copy(hand);
    }
  }
  pose(state);
  return { root, boardTilt, lean, pose, state };
}
