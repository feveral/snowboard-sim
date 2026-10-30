import * as THREE from 'three';
import { terrain, height, lodgeNear, branchAt, BRANCH_PERIOD, pisteCenter } from './terrain.js';
import { Rider, MODES } from './physics.js';
import { clamp } from './noise.js';
import {
  makeSky, makeMountains, TerrainMesh, Props, Snowfall, Atmosphere, makeLodge, makeSign, SUN_DIR, HAZE, ParkVisuals,
} from './env.js';
import { createRiderModel } from './riderModel.js';
import { Tracks, Spray, Powder } from './fx.js';
import { Crowd, animateRider, newVis } from './npc.js';
import { Game } from './game.js';
import { SnowAudio } from './audio.js';

const D = 180 / Math.PI;
const PHYS_DT = 1 / 120;
const isTouch = matchMedia('(pointer: coarse)').matches;

// ------------------------------------------------------------------ renderer / scene
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 2 : 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(HAZE.clone(), 60, 330);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2600);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.userData.baseFov = w < h ? 70 : 58;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const sky = makeSky(); scene.add(sky);
const mountains = makeMountains(); scene.add(mountains);
const hemi = new THREE.HemisphereLight(0xdcebff, 0x7d90ab, 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e2, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(isTouch ? 1536 : 2048, isTouch ? 1536 : 2048);
const SC = sun.shadow.camera; SC.left = -42; SC.right = 42; SC.top = 42; SC.bottom = -42; SC.near = 1; SC.far = 260;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

const terrainMesh = new TerrainMesh(scene);
const props = new Props(scene);
const parkVis = new ParkVisuals(scene);
const lodge = makeLodge(); scene.add(lodge);
const signs = [0, 1, 2].map((i) => {
  const types = [
    [{ text: '主線 Main →', color: '#1f5fd6', shape: 'square' }, { text: '← 蘑菇坡 Moguls', color: '#111', shape: 'diamond' }],
    [{ text: '主線 Main →', color: '#1f5fd6', shape: 'square' }, { text: '← 林間道 Trees', color: '#1f5fd6', shape: 'square' }],
    [{ text: '主線 Main →', color: '#1f5fd6', shape: 'square' }, { text: '← 陡坡 The Wall', color: '#111', shape: 'diamond' }],
  ];
  const s = makeSign(types[i]); s.visible = false; scene.add(s); return s;
});
const snowfall = new Snowfall(scene);
const atmos = new Atmosphere(scene, sky, mountains, sun, hemi, snowfall);

// ------------------------------------------------------------------ rider
const rider = new Rider(terrain);
const model = createRiderModel();
scene.add(model.root);
const tracks = new Tracks(scene);
const spray = new Spray(scene);
const powder = new Powder(scene);
const crowd = new Crowd(scene, 7);
const audio = new SnowAudio();

// ------------------------------------------------------------------ world streaming
function rebuildWorld() {
  const { cx, cz, R } = terrainMesh.rebuild(rider.p[0], rider.p[2]);
  props.gateState = new Map(game ? game.gateDone : []);
  props.rebuild(cx, cz, R);
  parkVis.update(rider.p[2]);
  const L = lodgeNear(cz);
  lodge.visible = !!L && Math.abs(L.z - cz) < R;
  if (L) { lodge.position.set(L.x, height(L.x, L.z) - 0.6, L.z); lodge.rotation.y = 0.15; }
  signs.forEach((s) => (s.visible = false));
  const k = Math.floor((cz - 360) / BRANCH_PERIOD);
  for (const kk of [k, k + 1]) {
    const b = branchAt(kk);
    if (!b) continue;
    const z = b.zs + 25, x = pisteCenter(z) + 15;
    if (Math.abs(z - cz) > R) continue;
    const s = signs[kk % 3];
    s.visible = true; s.position.set(x, height(x, z), z); s.rotation.y = Math.PI;
  }
}

// ------------------------------------------------------------------ game + HUD
const $ = (id) => document.getElementById(id);
const popups = $('popups');
function popup(text, cls) {
  const el = document.createElement('div');
  el.className = 'pop ' + (cls || '');
  el.textContent = text;
  popups.prepend(el);
  while (popups.children.length > 3) popups.lastChild.remove();
  setTimeout(() => el.classList.add('out'), 1500);
  setTimeout(() => el.remove(), 2100);
}
const vibrate = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
let game = null;
game = new Game(rider, (ev) => {
  if (ev.kind === 'gateState') { props.gateState.set(ev.k, ev.state); props.paintGates(); return; }
  if (ev.kind === 'crash') { vibrate(80); audio.thump(1.2); spray.burst([rider.p[0], rider.p[1] + 0.3, rider.p[2]], 140); powder.burst([rider.p[0], rider.p[1] + 0.3, rider.p[2]], 18, 1.3); return; }
  if (ev.kind === 'gate') { audio.ding(true); vibrate(15); }
  if (ev.kind === 'carve') audio.ding(false);
  const txt = ev.pts ? `${ev.label}  +${ev.pts}${ev.mult > 1 ? ` (×${ev.mult.toFixed(2).replace(/0$/, '')})` : ''}` : ev.label;
  popup(txt, ev.kind);
});

// ------------------------------------------------------------------ input: one thumb
const input = { steer: 0, pull: 0, ollie: false };
let ollieT = 0;
function triggerOllie() { const now = performance.now(); if (now - ollieT > 350) { ollieT = now; input.ollie = true; } }
const touch = { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 };
const keys = new Set();
const stick = $('stick'), knob = $('knob');
const ui = $('ui');
const scaleX = () => Math.min(window.innerWidth, window.innerHeight) * 0.36;
const scaleY = () => Math.min(window.innerWidth, window.innerHeight) * 0.25;
let hint = $('hint');
function hideHint() { if (hint) { hint.classList.add('gone'); hint = null; } }
ui.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, .panel')) return;
  audio.start();
  if (touch.active) return;
  touch.active = true; touch.id = e.pointerId;
  touch.ox = touch.x = e.clientX; touch.oy = touch.y = e.clientY;
  touch.hist = [{ y: e.clientY, t: performance.now() }];
  stick.style.display = 'block';
  stick.style.left = touch.ox + 'px'; stick.style.top = touch.oy + 'px';
  hideHint();
});
window.addEventListener('pointermove', (e) => {
  if (!touch.active || e.pointerId !== touch.id) return;
  touch.x = e.clientX; touch.y = e.clientY;
  // quick flick upward = ollie (a slow push up is just a tuck)
  const now = performance.now();
  touch.hist.push({ y: e.clientY, t: now });
  while (touch.hist.length > 2 && now - touch.hist[0].t > 90) touch.hist.shift();
  const h0 = touch.hist[0], dtF = (now - h0.t) / 1000;
  if (dtF > 0.015 && (e.clientY - h0.y) / dtF < -Math.max(650, scaleY() * 6.5)) triggerOllie();
  const sx = scaleX(), sy = scaleY();
  const dx = touch.x - touch.ox, dy = touch.y - touch.oy;
  if (dx > sx) touch.ox = touch.x - sx; if (dx < -sx) touch.ox = touch.x + sx;
  if (dy > sy) touch.oy = touch.y - sy; if (dy < -sy) touch.oy = touch.y + sy;
  stick.style.left = touch.ox + 'px'; stick.style.top = touch.oy + 'px';
});
const up = (e) => { if (e.pointerId !== touch.id) return; touch.active = false; touch.id = -1; stick.style.display = 'none'; };
window.addEventListener('pointerup', up);
window.addEventListener('pointercancel', up);
window.addEventListener('keydown', (e) => { if (e.key === ' ' && !e.repeat) triggerOllie(); keys.add(e.key.toLowerCase()); if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault(); hideHint(); audio.start(); });
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
document.addEventListener('gesturestart', (e) => e.preventDefault());

let kbSteer = 0;
function readInput(dt) {
  if (touch.active) {
    const dx = clamp((touch.x - touch.ox) / scaleX(), -1, 1);
    const dy = clamp((touch.y - touch.oy) / scaleY(), -1, 1);
    // progressive: small thumb movements = small edge angles, deep edges need a real push
    input.steer = Math.sign(dx) * Math.pow(Math.abs(dx), 1.8);
    input.pull = Math.abs(dy) < 0.15 ? 0 : (dy - Math.sign(dy) * 0.15) / 0.85;
    knob.style.transform = `translate(calc(-50% + ${dx * 46}px), calc(-50% + ${dy * 46}px))`;
  } else {
    const l = keys.has('arrowleft') || keys.has('a'), r = keys.has('arrowright') || keys.has('d');
    const tgt = (r ? 1 : 0) - (l ? 1 : 0);
    const max = keys.has('shift') ? 0.45 : 1;
    kbSteer += clamp(tgt * max - kbSteer, -1.4 * dt, 1.4 * dt);
    if (!l && !r) kbSteer += clamp(-kbSteer, -4 * dt, 4 * dt);
    input.steer = kbSteer;
    input.pull = (keys.has('arrowdown') || keys.has('s') ? 1 : 0) - (keys.has('arrowup') || keys.has('w') ? 1 : 0);
  }
}

// buttons
const CAMS = [
  { name: '高', h: 6.8, d: 10.5, ahead: 10, look: 0.15 },
  { name: '中', h: 4.4, d: 7.8, ahead: 8, look: 0.4 },
  { name: '近', h: 2.5, d: 5.0, ahead: 6, look: 0.8 },
];
let camMode = 0;
try { camMode = +(localStorage.getItem('sb_cam') || 0) % CAMS.length; } catch {}
$('cambtn').textContent = '🎥' + CAMS[camMode].name;
$('cambtn').addEventListener('click', () => {
  camMode = (camMode + 1) % CAMS.length; $('cambtn').textContent = '🎥' + CAMS[camMode].name;
  try { localStorage.setItem('sb_cam', String(camMode)); } catch {}
});
$('sndbtn').addEventListener('click', () => { audio.start(); audio.setOn(!audio.on); $('sndbtn').textContent = audio.on ? '🔊' : '🔇'; });
$('reset').addEventListener('click', () => { rider.reset(); tracks.clear(); game.reset(); camInit = false; rebuildWorld(); crowd.reset(rider); });
$('helpbtn').addEventListener('click', () => $('help').classList.toggle('show'));
$('help').addEventListener('click', (e) => { if (e.target.closest('#assistrow')) return; $('help').classList.remove('show'); });
let assist = 0.6;
try { const a = localStorage.getItem('sb_assist'); if (a !== null) assist = +a; } catch {}
function setAssist(a) {
  assist = a; rider.assist = a;
  document.querySelectorAll('.abtn').forEach((b) => b.classList.toggle('on', +b.dataset.a === a));
  try { localStorage.setItem('sb_assist', String(a)); } catch {}
}
document.querySelectorAll('.abtn').forEach((b) => b.addEventListener('click', () => setAssist(+b.dataset.a)));
setAssist(assist);

const hud = {
  speed: $('speed'), mode: $('mode'), bar: $('carvebar'), edge: $('edgeval'), edgeSide: $('edgeside'),
  needle: $('needle'), beta: $('beta'), g: $('gval'), rad: $('rad'), surf: $('surf'), msg: $('msg'),
  load: $('load'), score: $('score'), combo: $('combo'), best: $('best'), env: $('envlabel'), top: $('top'), dist: $('dist'),
};
let shownMode = MODES.stop, pendingMode = null, pendingT = 0, hudT = 0;
function modeLabel(m) {
  if (rider.tel.twist) return { text: '轉板 Pivot', cls: 'm-semicarve' };
  if (m === MODES.scrape && Math.abs(rider.edge) < 0.09) return { text: '橫滑 Sideslide', cls: 'm-scrape' };
  if (m === MODES.scrape || (m === MODES.skid && rider.tel.brake > 0.3)) {
    const heel = rider.edge < 0;
    return { text: heel ? '後刃推坡 Heelside' : '前刃推坡 Toeside', cls: 'm-scrape' };
  }
  return { text: m.label, cls: 'm-' + m.key };
}
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
  const ml = modeLabel(shownMode);
  hud.mode.textContent = ml.text;
  hud.mode.className = 'mode ' + ml.cls;
  hud.bar.style.width = Math.round(t.carveQ * 100) + '%';
  const e = rider.edge * D;
  hud.edge.textContent = Math.abs(e).toFixed(0) + '°';
  hud.edgeSide.textContent = (Math.abs(e) < 3 ? 'FLAT' : e > 0 ? 'TOE 前刃' : 'HEEL 後刃') + (rider.travel < 0 ? ' · 反腳' : '');
  hud.needle.style.transform = `rotate(${e}deg)`;
  hud.beta.textContent = (t.betaS * D).toFixed(0) + '°';
  hud.g.textContent = Math.min(9.9, Math.abs(t.latG)).toFixed(2) + 'g';
  hud.load.textContent = (rider.grounded ? (t.load ?? 1) : 0).toFixed(1) + 'g';
  hud.rad.textContent = isFinite(t.radius) && t.radius < 200 ? t.radius.toFixed(0) + 'm' : '—';
  hud.surf.textContent = t.ice > 0.4 ? '⚠ 冰面' : t.off > 0.5 ? '野雪' : '壓雪道';
  hud.score.textContent = game.score.toLocaleString();
  hud.combo.textContent = game.combo > 0 ? `COMBO ×${game.mult.toFixed(2).replace(/0$/, '')}` : '';
  hud.best.textContent = game.best.toLocaleString();
  hud.top.textContent = Math.round(rider.stats.maxSpeed * 3.6);
  hud.dist.textContent = (rider.stats.dist / 1000).toFixed(2);
  hud.env.textContent = atmos.label;
  if (rider.crashT > 0) { hud.msg.textContent = rider.crashReason; hud.msg.classList.add('show'); }
  else hud.msg.classList.remove('show');
}

// ------------------------------------------------------------------ camera
const camPos = new THREE.Vector3(), camDir = new THREE.Vector3(0, 0, 1), camLook = new THREE.Vector3(), lookS = new THREE.Vector3();
let camInit = false, shake = 0;
function updateCamera(dt) {
  const C = CAMS[camMode];
  const p = rider.p, v = rider.v;
  const hv = new THREE.Vector3(v[0], 0, v[2]);
  const sp = hv.length();
  const fl = new THREE.Vector3(rider.n[0], 0, rider.n[2]).normalize();
  const want = sp > 2.5 ? hv.clone().normalize() : fl.clone().lerp(new THREE.Vector3(rider.f[0], 0, rider.f[2]).multiplyScalar(rider.travel), 0.3).normalize();
  if (want.dot(fl) < -0.1) want.addScaledVector(fl, 0.8).normalize(); // never look back uphill
  const k = 1 - Math.exp(-dt * (sp > 2.5 ? 2.2 : 1.0));
  if (!camInit) camDir.copy(want); else camDir.lerp(want, k).normalize();
  const dist = C.d + Math.min(2.5, sp * 0.06), hgt = C.h + Math.min(1.2, sp * 0.03);
  const target = new THREE.Vector3(p[0], p[1], p[2]).addScaledVector(camDir, -dist);
  target.y = Math.max(p[1] + hgt, height(target.x, target.z) + 1.6);
  if (!camInit) { camPos.copy(target); }
  camPos.lerp(target, 1 - Math.exp(-dt * 6));
  camPos.y = Math.max(camPos.y, height(camPos.x, camPos.z) + 1.3);
  camLook.set(p[0], p[1], p[2]).addScaledVector(camDir, C.ahead);
  camLook.y = THREE.MathUtils.lerp(height(camLook.x, camLook.z), p[1], C.look) + 0.8;
  if (!camInit) { lookS.copy(camLook); camInit = true; }
  lookS.lerp(camLook, 1 - Math.exp(-dt * 8));
  camera.position.copy(camPos);
  shake += ((rider.tel.skid > 1 && rider.grounded ? Math.min(1, rider.tel.skid / 4) * Math.min(1, sp / 10) : 0) - shake) * Math.min(1, dt * 8);
  if (shake > 0.01) camera.position.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, 0).multiplyScalar(0.05 * shake));
  camera.lookAt(lookS);
  const fov = camera.userData.baseFov + Math.min(12, sp * 0.33);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 2); camera.updateProjectionMatrix(); }
  sky.position.copy(camera.position);
  mountains.position.set(camera.position.x * 0.97, camera.position.y * 0.9 - 60, camera.position.z * 0.97);
  // shadows follow the rider
  sun.target.position.set(p[0], p[1], p[2]).addScaledVector(camDir, 14);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 120);
}

// ------------------------------------------------------------------ rider visuals
const vis = newVis();
let wasGrounded = true;
function updateRiderVisual(dt) {
  const p = rider.p, t = rider.tel;
  animateRider(model, rider, vis, input, dt);
  // landing feedback
  if (rider.grounded && !wasGrounded && t.landed > 2) {
    audio.thump(Math.min(1.5, t.landed / 6)); vibrate(Math.min(60, t.landed * 6));
    spray.burst([p[0], p[1], p[2]], Math.min(120, t.landed * 15));
    powder.burst([p[0], p[1] + 0.2, p[2]], Math.min(14, 3 + t.landed * 1.5), 0.8);
  }
  wasGrounded = rider.grounded;
}

// ------------------------------------------------------------------ main loop
rebuildWorld();
let last = performance.now(), acc = 0, paused = false;
document.addEventListener('visibilitychange', () => { paused = document.hidden; last = performance.now(); });
function frame(now) {
  requestAnimationFrame(frame);
  if (paused) return;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  readInput(dt);
  acc += dt;
  let steps = 0;
  while (acc >= PHYS_DT && steps < 12) { rider.step(PHYS_DT, input); input.ollie = false; rider.tel.ollie = rider.grounded ? false : rider.tel.ollie; acc -= PHYS_DT; steps++; game.update(PHYS_DT); }
  if (steps === 12) acc = 0;
  if (Math.hypot(rider.p[0] - terrainMesh.center.x, rider.p[2] - terrainMesh.center.z) > 20) rebuildWorld();
  if (input.ollie && !rider.grounded) input.ollie = false;
  updateRiderVisual(dt);
  tracks.update(rider, dt);
  spray.fromRider(rider, shownMode.key, dt);
  powder.fromRider(rider, shownMode.key, dt);
  crowd.update(dt, rider, { powder, spray }, () => { audio.thump(1.3); vibrate(120); });
  spray.update(dt);
  powder.update(dt, [snowfall.wind ? 0.6 * Math.sin(atmos.clock * 0.17) : 0.4, -0.3]);
  props.update(dt);
  atmos.update(dt, camera.position);
  updateCamera(dt);
  snowfall.update(dt, camera.position, atmos.weather);
  lodge.userData.win.emissiveIntensity = 0.2 + 1.8 * (1 - Math.min(1, SUN_DIR.y * 3));
  powder.mat.uniforms.uLight.value.copy(sun.color).lerp(new THREE.Color(1, 1, 1), 0.6);
  audio.update(rider, shownMode.key, dt);
  updateHUD(dt);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
window.__game = { rider, input, keys, game, atmos, tracks, camera, scene, crowd };
