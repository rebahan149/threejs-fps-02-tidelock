// fx.js — the transient visuals: tracer rounds, impact sparks, smoke clouds, flash pops,
// the charge's blinking beacon, live grenades and the player's view-model gun. Everything
// is pooled and reused; per-frame work allocates nothing.

import * as THREE from 'three';
import { G } from './state.js';
import { PAL, glowMat } from './palette.js';

let scene = null;
let tracerLines = null;
let tracerData = null; // Float32Array positions
const TRACER_MAX = 128;
let tracerHead = 0;
const tracerAge = new Float32Array(TRACER_MAX);

let sparks = null;
let sparkData = null;
const SPARK_MAX = 240;
let sparkHead = 0;
const sparkVel = new Float32Array(SPARK_MAX * 3);
const sparkAge = new Float32Array(SPARK_MAX);

let smokeGroup = null;
const smokeVisuals = new Map(); // logical smoke -> { group, sprites }
let puffTex = null;

let boomLight = null;
let boomSprite = null;
let boomAt = -99;
let flashSprites = [];

const fragMeshes = [];
let chargeMesh = null;
let chargeLightMat = null;

function makePuffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(216,220,224,0.85)');
  grad.addColorStop(0.55, 'rgba(190,196,202,0.5)');
  grad.addColorStop(1, 'rgba(180,186,192,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function initFx(s) {
  scene = s;
  puffTex = makePuffTexture();

  tracerData = new Float32Array(TRACER_MAX * 6);
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(tracerData, 3).setUsage(THREE.DynamicDrawUsage));
  tracerLines = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.75 }));
  tracerLines.frustumCulled = false;
  scene.add(tracerLines);

  sparkData = new Float32Array(SPARK_MAX * 3);
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sparkData, 3).setUsage(THREE.DynamicDrawUsage));
  sparks = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffc37a, size: 0.09, transparent: true, opacity: 0.95 }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  for (let i = 0; i < SPARK_MAX; i++) sparkData[i * 3 + 1] = -50;

  smokeGroup = new THREE.Group();
  scene.add(smokeGroup);

  boomLight = new THREE.PointLight(0xffa050, 0, 26, 2);
  scene.add(boomLight);
  boomSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0xffb060, transparent: true, opacity: 0 }));
  boomSprite.scale.set(4, 4, 1);
  scene.add(boomSprite);

  // The charge: a slab with a beacon that blinks faster as the timer runs down.
  chargeMesh = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.3), new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.5 }));
  slab.position.y = 0.08;
  chargeMesh.add(slab);
  chargeLightMat = glowMat(PAL.charge, 3);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), chargeLightMat);
  beacon.position.y = 0.2;
  chargeMesh.add(beacon);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 5), slab.material);
  mast.position.y = 0.3;
  chargeMesh.add(mast);
  scene.add(chargeMesh);
}

function addTracer(e) {
  const i = tracerHead;
  tracerHead = (tracerHead + 1) % TRACER_MAX;
  tracerData.set([e.x0, e.y0, e.z0, e.x1, e.y1, e.z1], i * 6);
  tracerAge[i] = 0.07;
  // A few sparks where the round lands.
  for (let k = 0; k < 3; k++) {
    const j = sparkHead;
    sparkHead = (sparkHead + 1) % SPARK_MAX;
    sparkData.set([e.x1, e.y1, e.z1], j * 3);
    sparkVel[j * 3] = (Math.random() - 0.5) * 1.6;
    sparkVel[j * 3 + 1] = Math.random() * 1.8;
    sparkVel[j * 3 + 2] = (Math.random() - 0.5) * 1.6;
    sparkAge[j] = 0.3;
  }
}

function addFlashBurst(e) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, color: 0xffffff, transparent: true, opacity: 0.95 }));
  sp.position.set(e.x, e.y, e.z);
  sp.scale.set(2.2, 2.2, 1);
  scene.add(sp);
  flashSprites.push({ sp, age: 0.22 });
}

function addBoom(e) {
  boomAt = G.time;
  boomLight.position.set(e.x, 1.2, e.z);
  boomSprite.position.set(e.x, 0.9, e.z);
}

export function consumeFxEvents(events) {
  for (const e of events) {
    if (e.kind === 'tracer') addTracer(e);
    else if (e.kind === 'boom') addBoom(e);
    else if (e.kind === 'flashburst') addFlashBurst(e);
  }
}

const fragGeo = new THREE.SphereGeometry(0.09, 8, 8);
const fragMat = new THREE.MeshStandardMaterial({ color: 0x30363a, roughness: 0.45, metalness: 0.6 });

export function updateFx(dt) {
  // Tracers fade by shrinking to a point (positions are cheap, materials are shared).
  let dirty = false;
  for (let i = 0; i < TRACER_MAX; i++) {
    if (tracerAge[i] > 0) {
      tracerAge[i] -= dt;
      if (tracerAge[i] <= 0) {
        tracerData[i * 6 + 1] = -50;
        tracerData[i * 6 + 4] = -50;
      }
      dirty = true;
    }
  }
  if (dirty) tracerLines.geometry.attributes.position.needsUpdate = true;

  let sDirty = false;
  for (let i = 0; i < SPARK_MAX; i++) {
    if (sparkAge[i] > 0) {
      sparkAge[i] -= dt;
      sparkData[i * 3] += sparkVel[i * 3] * dt;
      sparkData[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
      sparkData[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
      sparkVel[i * 3 + 1] -= 5 * dt;
      if (sparkAge[i] <= 0) sparkData[i * 3 + 1] = -50;
      sDirty = true;
    }
  }
  if (sDirty) sparks.geometry.attributes.position.needsUpdate = true;

  // Smoke: keep one billowing cluster per logical cloud.
  for (const s of G.smokes) {
    if (!smokeVisuals.has(s)) {
      const grp = new THREE.Group();
      const sprites = [];
      for (let k = 0; k < 7; k++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, opacity: 0, depthWrite: false }));
        const ang = (k / 7) * Math.PI * 2;
        sp.position.set(Math.cos(ang) * s.r * 0.45, 1 + (k % 3) * 0.55, Math.sin(ang) * s.r * 0.45);
        grp.add(sp);
        sprites.push(sp);
      }
      grp.position.set(s.x, 0, s.z);
      smokeGroup.add(grp);
      smokeVisuals.set(s, { grp, sprites });
    }
  }
  for (const [s, v] of smokeVisuals) {
    if (!G.smokes.includes(s)) {
      smokeGroup.remove(v.grp);
      smokeVisuals.delete(s);
      continue;
    }
    const grow = Math.min(1, (G.time - s.bornAt) / 1.1);
    const fade = Math.min(1, (s.until - G.time) / 2.2);
    const o = 0.62 * grow * Math.max(0, fade);
    for (const sp of v.sprites) {
      sp.material.opacity = o;
      const sc = s.r * (0.9 + grow * 0.7);
      sp.scale.set(sc, sc, 1);
    }
  }

  // Flash pops shrink and vanish.
  for (let i = flashSprites.length - 1; i >= 0; i--) {
    const f = flashSprites[i];
    f.age -= dt;
    f.sp.material.opacity = Math.max(0, f.age / 0.22) * 0.95;
    if (f.age <= 0) {
      scene.remove(f.sp);
      flashSprites.splice(i, 1);
    }
  }

  // Explosion light and fireball.
  const boomAge = G.time - boomAt;
  if (boomAge < 0.45) {
    boomLight.intensity = 260 * (1 - boomAge / 0.45);
    boomSprite.material.opacity = 0.85 * (1 - boomAge / 0.45);
    const sc = 3 + boomAge * 12;
    boomSprite.scale.set(sc, sc, 1);
  } else {
    boomLight.intensity = 0;
    boomSprite.material.opacity = 0;
  }

  // Live grenades.
  while (fragMeshes.length < G.frags.length) {
    const m = new THREE.Mesh(fragGeo, fragMat);
    scene.add(m);
    fragMeshes.push(m);
  }
  for (let i = 0; i < fragMeshes.length; i++) {
    const m = fragMeshes[i];
    if (i < G.frags.length) {
      m.visible = true;
      m.position.set(G.frags[i].x, G.frags[i].y, G.frags[i].z);
    } else m.visible = false;
  }

  // The charge follows its state: on the carrier's back, on the ground, or planted.
  const ch = G.charge;
  if (ch.state === 'carried' && ch.carrier) {
    chargeMesh.visible = true;
    chargeMesh.position.set(ch.carrier.x, 1.15, ch.carrier.z);
    chargeMesh.rotation.y = -ch.carrier.yaw;
    chargeLightMat.emissiveIntensity = 1.2;
  } else if (ch.state === 'dropped') {
    chargeMesh.visible = true;
    chargeMesh.position.set(ch.x, 0, ch.z);
    chargeMesh.rotation.y = 0.6;
    chargeLightMat.emissiveIntensity = (Math.sin(G.time * 4) > 0 ? 2.4 : 0.4);
  } else if (ch.state === 'planted') {
    chargeMesh.visible = true;
    chargeMesh.position.set(ch.x, 0, ch.z);
    const remain = Math.max(0, ch.plantAt + 35 - G.time);
    const rate = remain < 8 ? 10 : remain < 20 ? 5 : 2;
    chargeLightMat.emissiveIntensity = (Math.sin(G.time * rate * Math.PI) > 0 ? 3.2 : 0.3);
  } else chargeMesh.visible = false;
}

// ---- View model -------------------------------------------------------------

const viewModels = {};
let viewRoot = null;
let viewFlash = null;
let viewFlashAt = -99;

function vmBox(w, h, d, material, x, y, z, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// One low-poly gun per weapon kind, built from boxes, held low-right of the camera.
export function buildViewModels(camera) {
  viewRoot = new THREE.Group();
  camera.add(viewRoot);
  const dark = new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.45, metalness: 0.55 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xc7742c, roughness: 0.5, metalness: 0.3 });
  const shapes = {
    pistol: [[0.05, 0.09, 0.24, 0, 0, -0.1], [0.045, 0.14, 0.05, 0, -0.1, 0.02]],
    smg: [[0.055, 0.1, 0.42, 0, 0, -0.16], [0.04, 0.2, 0.05, 0, -0.13, -0.05], [0.05, 0.07, 0.16, 0, 0.07, -0.3]],
    scatter: [[0.07, 0.11, 0.55, 0, 0, -0.22], [0.075, 0.06, 0.2, 0, -0.07, -0.28]],
    rifle: [[0.055, 0.1, 0.52, 0, 0, -0.2], [0.04, 0.18, 0.05, 0, -0.12, -0.02], [0.05, 0.08, 0.05, 0, 0.08, -0.24]],
    dmr: [[0.05, 0.09, 0.68, 0, 0, -0.28], [0.06, 0.09, 0.14, 0, 0.1, -0.18], [0.04, 0.16, 0.05, 0, -0.11, 0.0]],
  };
  for (const [kind, parts] of Object.entries(shapes)) {
    const g = new THREE.Group();
    for (const [w, h, d, x, y, z] of parts) vmBox(w, h, d, dark, x, y, z, g);
    vmBox(0.056, 0.03, 0.1, accent, 0, -0.02, -0.3, g);
    g.position.set(0.24, -0.22, -0.45);
    g.visible = false;
    viewRoot.add(g);
    viewModels[kind] = g;
  }
  viewFlash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.16),
    new THREE.MeshBasicMaterial({ color: 0xffcf7d, transparent: true, opacity: 0, depthWrite: false }),
  );
  viewFlash.position.set(0.24, -0.2, -0.95);
  viewRoot.add(viewFlash);
}

let bobPhase = 0;
export function updateViewModel(kind, dt, moving, speed, firedAt, reloading, scoped) {
  if (!viewRoot) return;
  for (const [k, g] of Object.entries(viewModels)) g.visible = k === kind && !scoped;
  const g = viewModels[kind];
  if (!g) return;
  bobPhase += dt * (moving ? speed * 1.6 : 0);
  const bobY = moving ? Math.abs(Math.sin(bobPhase)) * 0.018 : 0;
  const recoil = Math.max(0, 1 - (performance.now() / 1000 - firedAt) * 7);
  g.position.set(0.24, -0.22 + bobY + (reloading ? -0.09 : 0), -0.45 + recoil * 0.06);
  g.rotation.x = recoil * 0.09 + (reloading ? 0.5 : 0);
  if (firedAt !== viewFlashAt) {
    viewFlashAt = firedAt;
    viewFlash.material.opacity = 0.9;
    viewFlash.rotation.z = Math.random() * 3;
  }
  viewFlash.material.opacity = Math.max(0, viewFlash.material.opacity - dt * 9);
  viewRoot.visible = !scoped;
}
