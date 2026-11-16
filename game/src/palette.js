// palette.js — TIDELOCK's dusk-harbour palette and the shared materials built from it.
// One place for colour so the whole map reads as one chosen look: deep teal water and
// shadow, warm sodium light, rust and container paint against a bruised amber sky.

import * as THREE from 'three';

export const PAL = {
  skyZenith: 0x1d3a4a,
  skyHorizon: 0xf2a65e,
  skyLow: 0x513b4d,
  fog: 0xcf9464,
  sun: 0xffb36b,
  hemiSky: 0x7fb2c9,
  hemiGround: 0x4a3a33,
  concrete: 0x8d8d90,
  concreteDark: 0x5d6066,
  asphalt: 0x46484e,
  water: 0x14586b,
  waterDeep: 0x0b3547,
  steel: 0x707a82,
  steelDark: 0x3c434a,
  rust: 0xa8542f,
  lampGlow: 0xffc37a,
  // Container paint, weathered.
  boxRed: 0x9e4038,
  boxBlue: 0x2e5f7a,
  boxGreen: 0x3f7355,
  boxOchre: 0xb98a35,
  boxGrey: 0x767c80,
  // Teams: Breakers wear rust orange, Wardens wear harbour teal.
  brk: 0xd96c33,
  brkDark: 0x59331f,
  wrd: 0x2e8fa3,
  wrdDark: 0x1d3f4a,
  siteA: 0xffb347,
  siteB: 0x6ee7c8,
  charge: 0xff5347,
  white: 0xf5f1e8,
};

// Materials are created once and shared; nothing in the hot loop allocates new ones.
const cache = new Map();
export function mat(color, rough = 0.9, metal = 0.0) {
  const key = `${color}|${rough}|${metal}`;
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    cache.set(key, m);
  }
  return m;
}

export function glowMat(color, intensity = 2.2) {
  const key = `glow|${color}|${intensity}`;
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: intensity,
      roughness: 0.4,
      metalness: 0,
    });
    cache.set(key, m);
  }
  return m;
}

// A small procedural equirectangular canvas (dusk gradient, one low sun, dark ground) that
// main.js turns into a PMREM environment so metals and water pick up the sky's colours.
export function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.0, '#16283a');
  grad.addColorStop(0.42, '#3d5a6e');
  grad.addColorStop(0.55, '#c97e4e');
  grad.addColorStop(0.62, '#f2a65e');
  grad.addColorStop(0.68, '#5a4038');
  grad.addColorStop(1.0, '#14161c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 512);
  // The sun: a bright disc just above the horizon, with a soft halo.
  const sun = g.createRadialGradient(720, 330, 4, 720, 330, 130);
  sun.addColorStop(0, 'rgba(255,230,180,1)');
  sun.addColorStop(0.12, 'rgba(255,190,110,0.85)');
  sun.addColorStop(1, 'rgba(255,160,80,0)');
  g.fillStyle = sun;
  g.fillRect(560, 170, 320, 320);
  g.fillStyle = '#fff3d0';
  g.beginPath();
  g.arc(720, 330, 13, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Corrugated container siding drawn once on a canvas: vertical ribs, grime at the foot,
// stencilled unit numbers. Tint comes from the material colour multiplied over it.
export function makeContainerTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#cfcfcf';
  g.fillRect(0, 0, 512, 256);
  for (let x = 0; x < 512; x += 32) {
    const rib = g.createLinearGradient(x, 0, x + 32, 0);
    rib.addColorStop(0, 'rgba(0,0,0,0.28)');
    rib.addColorStop(0.5, 'rgba(255,255,255,0.13)');
    rib.addColorStop(1, 'rgba(0,0,0,0.28)');
    g.fillStyle = rib;
    g.fillRect(x, 0, 32, 256);
  }
  const grime = g.createLinearGradient(0, 170, 0, 256);
  grime.addColorStop(0, 'rgba(30,20,12,0)');
  grime.addColorStop(1, 'rgba(30,20,12,0.45)');
  g.fillStyle = grime;
  g.fillRect(0, 170, 512, 86);
  g.fillStyle = 'rgba(20,16,12,0.55)';
  g.font = 'bold 44px monospace';
  g.fillText('TLU 481 207', 26, 66);
  g.font = 'bold 25px monospace';
  g.fillText('MAX 30480 KG', 26, 226);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// The apron: one big canvas of stained concrete with painted lane lines, a pedestrian
// walkway and the two site rings with their letters, so the ground itself teaches the map.
export function makeGroundTexture(siteA, siteB, world) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const g = c.getContext('2d');
  const px = (x) => ((x - world.minX) / (world.maxX - world.minX)) * 1024;
  const pz = (z) => ((z - world.minZ) / (world.maxZ - world.minZ)) * 1024;
  const sx = 1024 / (world.maxX - world.minX);
  g.fillStyle = '#83838a';
  g.fillRect(0, 0, 1024, 1024);
  // Stains and patch repairs.
  let seed = 9;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(${40 + rnd() * 40},${38 + rnd() * 36},${34 + rnd() * 30},${0.05 + rnd() * 0.1})`;
    g.beginPath();
    g.ellipse(rnd() * 1024, rnd() * 1024, 12 + rnd() * 70, 8 + rnd() * 44, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // Expansion joints.
  g.strokeStyle = 'rgba(30,30,34,0.35)';
  g.lineWidth = 2;
  for (let i = 1; i < 8; i++) {
    g.beginPath(); g.moveTo((i * 1024) / 8, 0); g.lineTo((i * 1024) / 8, 1024); g.stroke();
    g.beginPath(); g.moveTo(0, (i * 1024) / 8); g.lineTo(1024, (i * 1024) / 8); g.stroke();
  }
  // Painted lane arrows along the two side lanes.
  g.fillStyle = 'rgba(240,230,200,0.5)';
  for (const z of [-17.5, 17.5]) {
    for (let x = -28; x <= 28; x += 14) {
      const X = px(x), Z = pz(z);
      g.beginPath();
      g.moveTo(X - 16, Z - 7); g.lineTo(X + 6, Z - 7); g.lineTo(X + 6, Z - 14);
      g.lineTo(X + 24, Z); g.lineTo(X + 6, Z + 14); g.lineTo(X + 6, Z + 7); g.lineTo(X - 16, Z + 7);
      g.closePath(); g.fill();
    }
  }
  // Site rings and letters.
  for (const [site, label, col] of [[siteA, 'A', '#ffb347'], [siteB, 'B', '#6ee7c8']]) {
    g.strokeStyle = col;
    g.lineWidth = 7;
    g.beginPath();
    g.arc(px(site.x), pz(site.z), site.r * sx, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = col;
    g.font = 'bold 92px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, px(site.x), pz(site.z));
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
