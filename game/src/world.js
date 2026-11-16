// world.js — TIDELOCK's map: a tidal harbour lock at dusk. This module owns the static
// world: the collider list every movement and bullet query runs against, the waypoint
// graph the bots navigate, the two charge sites, the spawns, and all of the geometry —
// container lanes, a canal crossed by two bridges, a gantry crane over Site A and the
// lock gates at Site B. It also builds the low-poly figures the actors wear.

import * as THREE from 'three';
import { PAL, mat, glowMat, makeGroundTexture, makeContainerTexture } from './palette.js';
import { G } from './state.js';

export const BOUNDS = { minX: -36, maxX: 36, minZ: -24, maxZ: 24 };
export const SITES = {
  A: { id: 'A', name: 'Crane Deck', x: 24, z: -14, r: 6.5 },
  B: { id: 'B', name: 'Gatehouse', x: 24, z: 14, r: 6.5 },
};
export const SPAWNS = {
  BRK: [[-31, -6], [-31, -2], [-31, 2], [-31, 6], [-29, 0]],
  WRD: [[31, -4], [31, 0], [31, 4], [29, -8], [29, 8]],
};

// Colliders are axis-aligned boxes standing on the ground: { x0, x1, z0, z1, h }.
// Movement collides in 2D against all of them; bullets and sight lines collide in 3D
// against the box from y=0 to y=h.
export const colliders = [];
function solid(x0, x1, z0, z1, h) {
  const c = { x0, x1, z0, z1, h };
  colliders.push(c);
  return c;
}

// ---- 2D helpers -------------------------------------------------------------

export function pointInCollider(x, z, pad = 0) {
  for (const c of colliders) {
    if (x > c.x0 - pad && x < c.x1 + pad && z > c.z0 - pad && z < c.z1 + pad) return c;
  }
  return null;
}

// Does the 2D segment cross any collider (inflated by pad)? Used for path edges.
export function segmentBlocked(x1, z1, x2, z2, pad = 0.35) {
  for (const c of colliders) {
    if (segAabb(x1, z1, x2, z2, c.x0 - pad, c.z0 - pad, c.x1 + pad, c.z1 + pad)) return true;
  }
  return false;
}

function segAabb(x1, z1, x2, z2, bx0, bz0, bx1, bz1) {
  // Liang–Barsky clip against the box.
  const dx = x2 - x1, dz = z2 - z1;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dz, dz];
  const q = [x1 - bx0, bx1 - x1, z1 - bz0, bz1 - z1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
  }
  return true;
}

// Move a circle (x, z, radius r) by (dx, dz), sliding along colliders and the bounds.
export function slideMove(pos, dx, dz, r) {
  let nx = pos.x + dx;
  if (!pointInCollider(nx, pos.z, r - 0.001) || pointInCollider(pos.x, pos.z, r - 0.001)) {
    // Only accept the new x if the destination circle is clear, or we were already stuck.
    if (!circleHits(nx, pos.z, r)) pos.x = nx;
  }
  let nz = pos.z + dz;
  if (!circleHits(pos.x, nz, r)) pos.z = nz;
  pos.x = Math.max(BOUNDS.minX + r, Math.min(BOUNDS.maxX - r, pos.x));
  pos.z = Math.max(BOUNDS.minZ + r, Math.min(BOUNDS.maxZ - r, pos.z));
}

function circleHits(x, z, r) {
  for (const c of colliders) {
    const cx = Math.max(c.x0, Math.min(c.x1, x));
    const cz = Math.max(c.z0, Math.min(c.z1, z));
    const ddx = x - cx, ddz = z - cz;
    if (ddx * ddx + ddz * ddz < r * r) return true;
  }
  return false;
}

// ---- 3D rays ----------------------------------------------------------------

// Ray vs every collider box (y from 0 to h). Returns the nearest t or Infinity.
export function rayWorld(ox, oy, oz, dx, dy, dz, maxDist) {
  let best = maxDist;
  for (const c of colliders) {
    const t = rayAabb(ox, oy, oz, dx, dy, dz, c.x0, 0, c.z0, c.x1, c.h, c.z1);
    if (t !== null && t < best) best = t;
  }
  // The ground plane.
  if (dy < -1e-6) {
    const t = -oy / dy;
    if (t > 0 && t < best) best = t;
  }
  return best;
}

function rayAabb(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let tmin = 0, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
    } else {
      let t1 = (lo[i] - o[i]) / d[i];
      let t2 = (hi[i] - o[i]) / d[i];
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// Sight line between two points: blocked by geometry (above crouch height matters, so
// test the full box) or by a smoke cloud's sphere.
export function losBlocked(x1, y1, z1, x2, y2, z2) {
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return false;
  const t = rayWorld(x1, y1, z1, dx / dist, dy / dist, dz / dist, dist);
  if (t < dist - 0.05) return true;
  for (const s of G.smokes) {
    if (segmentSphere(x1, y1, z1, dx, dy, dz, dist, s.x, 1.1, s.z, s.r)) return true;
  }
  return false;
}

function segmentSphere(ox, oy, oz, dx, dy, dz, len, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const t = Math.max(0, Math.min(len, (lx * dx + ly * dy + lz * dz) / len));
  const px = ox + (dx / len) * t - cx, py = oy + (dy / len) * t - cy, pz = oz + (dz / len) * t - cz;
  return px * px + py * py + pz * pz < r * r;
}

export function inSmoke(x, y, z) {
  for (const s of G.smokes) {
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz < s.r * s.r && y < 2.6) return true;
  }
  return false;
}

// ---- Waypoints --------------------------------------------------------------

export const nodes = []; // { x, z, edges: [indices] }
export function buildGraph() {
  nodes.length = 0;
  const step = 3;
  const index = new Map();
  for (let x = BOUNDS.minX + 2; x <= BOUNDS.maxX - 2; x += step) {
    for (let z = BOUNDS.minZ + 2; z <= BOUNDS.maxZ - 2; z += step) {
      if (pointInCollider(x, z, 0.5)) continue;
      index.set(`${x},${z}`, nodes.length);
      nodes.push({ x, z, edges: [] });
    }
  }
  const dirs = [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [step, -step], [-step, step], [-step, -step]];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    for (const [dx, dz] of dirs) {
      const j = index.get(`${n.x + dx},${n.z + dz}`);
      if (j === undefined) continue;
      if (segmentBlocked(n.x, n.z, n.x + dx, n.z + dz, 0.32)) continue;
      n.edges.push(j);
    }
  }
}

export function nearestNode(x, z) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const dx = nodes[i].x - x, dz = nodes[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Dijkstra over the waypoint graph; returns a list of {x, z} waypoints (not including the
// start, including the goal's node) or [] when already close / unreachable.
export function findPath(x1, z1, x2, z2) {
  const start = nearestNode(x1, z1);
  const goal = nearestNode(x2, z2);
  if (start === goal || start < 0 || goal < 0) return [];
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const done = new Uint8Array(nodes.length);
  dist[start] = 0;
  for (;;) {
    let u = -1, du = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!done[i] && dist[i] < du) { du = dist[i]; u = i; }
    }
    if (u === -1 || u === goal) break;
    done[u] = 1;
    for (const v of nodes[u].edges) {
      const w = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);
      if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
  }
  if (prev[goal] === -1 && goal !== start) return [{ x: x2, z: z2 }];
  const path = [];
  let cur = goal;
  while (cur !== start && cur !== -1) {
    path.push({ x: nodes[cur].x, z: nodes[cur].z });
    cur = prev[cur];
  }
  path.reverse();
  if (path.length) path[path.length - 1] = { x: x2, z: z2 };
  return path;
}

// ---- Directions -------------------------------------------------------------

export function dirFrom(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: cp * Math.sin(yaw), y: Math.sin(pitch), z: -cp * Math.cos(yaw) };
}
export const forward2D = (yaw) => ({ x: Math.sin(yaw), z: -Math.cos(yaw) });
export const right2D = (yaw) => ({ x: Math.cos(yaw), z: Math.sin(yaw) });
export const yawTo = (fx, fz, tx, tz) => Math.atan2(tx - fx, -(tz - fz));

// ---- Geometry ---------------------------------------------------------------

const animated = []; // { tex, speed } water shimmer, advanced by tickWorld
export function tickWorld(dt) {
  for (const a of animated) a.tex.offset.y -= dt * a.speed;
}

function box(w, h, d, material, x, y, z, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = false;
  m.receiveShadow = false;
  parent.add(m);
  return m;
}

let containerTex = null;
function container(parent, cx, cz, axis, levels, color) {
  const L = 6.1, W = 2.44, H = 2.6;
  const w = axis === 'x' ? L : W;
  const d = axis === 'x' ? W : L;
  solid(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, H * levels);
  if (!containerTex) containerTex = makeContainerTexture();
  const side = new THREE.MeshStandardMaterial({ map: containerTex, color, roughness: 0.75, metalness: 0.25 });
  for (let i = 0; i < levels; i++) {
    box(w, H, d, side, cx, H / 2 + i * H, cz, parent);
  }
  // Corner posts read as structure at a glance.
  const post = mat(PAL.steelDark, 0.6, 0.5);
  for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    box(0.18, H * levels, 0.18, post, cx + px * (w / 2 - 0.09), (H * levels) / 2, cz + pz * (d / 2 - 0.09), parent);
  }
}

function crate(parent, x, z, big = false) {
  const s = big ? 1.7 : 1.25;
  solid(x - s / 2, x + s / 2, z - s / 2, z + s / 2, s);
  box(s, s, s, mat(0x9a7d4f, 0.95), x, s / 2, z, parent);
  box(s + 0.06, 0.1, s + 0.06, mat(0x6e5836, 0.95), x, s / 2, z, parent);
}

function barrels(parent, x, z) {
  solid(x - 0.75, x + 0.75, z - 0.75, z + 0.75, 0.92);
  const geo = new THREE.CylinderGeometry(0.34, 0.34, 0.92, 10);
  for (const [dx, dz, c] of [[-0.36, -0.36, PAL.rust], [0.36, -0.3, PAL.boxBlue], [0, 0.38, PAL.boxGreen]]) {
    const m = new THREE.Mesh(geo, mat(c, 0.6, 0.4));
    m.position.set(x + dx, 0.46, z + dz);
    parent.add(m);
  }
}

function lamp(parent, scene, x, z, withLight) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 4.6, 8), mat(PAL.steelDark, 0.5, 0.6));
  pole.position.set(x, 2.3, z);
  parent.add(pole);
  box(0.5, 0.12, 0.3, glowMat(PAL.lampGlow, 2.6), x, 4.65, z, parent);
  if (withLight) {
    const l = new THREE.PointLight(PAL.lampGlow, 60, 30, 2);
    l.position.set(x, 4.4, z);
    scene.add(l);
  }
}

export function buildWorld(scene) {
  const root = new THREE.Group();
  scene.add(root);

  // Ground apron with painted lanes and site rings.
  const groundTex = makeGroundTexture(SITES.A, SITES.B, BOUNDS);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(BOUNDS.maxX - BOUNDS.minX, BOUNDS.maxZ - BOUNDS.minZ),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.94, metalness: 0.02 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  // The sea all around, and the canal water sunk into its trench.
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), mat(PAL.waterDeep, 0.25, 0.1));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = -1.05;
  root.add(sea);
  const stripeC = document.createElement('canvas');
  stripeC.width = 64; stripeC.height = 64;
  const sg = stripeC.getContext('2d');
  sg.fillStyle = '#1a6a84';
  sg.fillRect(0, 0, 64, 64);
  sg.fillStyle = 'rgba(255,210,150,0.20)';
  sg.fillRect(0, 8, 64, 5);
  sg.fillStyle = 'rgba(255,255,255,0.10)';
  sg.fillRect(0, 38, 64, 3);
  const stripeTex = new THREE.CanvasTexture(stripeC);
  stripeTex.wrapS = stripeTex.wrapT = THREE.RepeatWrapping;
  stripeTex.repeat.set(1, 16);
  animated.push({ tex: stripeTex, speed: 0.05 });
  const canal = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 48),
    new THREE.MeshStandardMaterial({ map: stripeTex, color: 0xbfd9de, roughness: 0.18, metalness: 0.35 }),
  );
  canal.rotation.x = -Math.PI / 2;
  canal.position.set(0, -0.8, 0);
  root.add(canal);
  // Canal trench walls.
  for (const s of [-1, 1]) {
    box(0.3, 1.0, 48, mat(PAL.concreteDark, 0.9), s * 3.15, -0.5, 0, root);
  }

  // Perimeter walls.
  const wallMat = mat(PAL.concreteDark, 0.85, 0.1);
  box(73.2, 4.4, 0.6, wallMat, 0, 2.2, -24.3, root); solid(-36.6, 36.6, -24.6, -24, 4.4);
  box(73.2, 4.4, 0.6, wallMat, 0, 2.2, 24.3, root); solid(-36.6, 36.6, 24, 24.6, 4.4);
  box(0.6, 4.4, 49.2, wallMat, -36.3, 2.2, 0, root); solid(-36.6, -36, -24.6, 24.6, 4.4);
  box(0.6, 4.4, 49.2, wallMat, 36.3, 2.2, 0, root); solid(36, 36.6, -24.6, 24.6, 4.4);
  // A railing stripe along the top of each wall catches the sunset.
  box(73.2, 0.18, 0.7, mat(PAL.rust, 0.7, 0.3), 0, 4.45, -24.3, root);
  box(73.2, 0.18, 0.7, mat(PAL.rust, 0.7, 0.3), 0, 4.45, 24.3, root);

  // Canal banks (low walls) with two bridge gaps, and the bridges themselves.
  for (const s of [-1, 1]) {
    for (const [z0, z1] of [[-24, -13], [-9, 9], [13, 24]]) {
      box(0.6, 1.05, z1 - z0, mat(PAL.concrete, 0.9), s * 3.3, 0.52, (z0 + z1) / 2, root);
      solid(Math.min(s * 3.0, s * 3.6), Math.max(s * 3.0, s * 3.6), z0, z1, 1.05);
    }
  }
  const plank = mat(0x7d6242, 0.95);
  for (const zc of [-11, 11]) {
    box(7.4, 0.18, 4.4, plank, 0, 0.02, zc, root);
    for (const e of [-1, 1]) {
      box(7.4, 0.85, 0.14, mat(PAL.steelDark, 0.6, 0.5), 0, 0.45, zc + e * 2.05, root);
      solid(-3.7, 3.7, zc + e * 2.05 - 0.07, zc + e * 2.05 + 0.07, 0.85);
    }
    // Bollards along the banks.
    for (const bx of [-4.6, 4.6]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.7, 8), mat(PAL.steelDark, 0.5, 0.6));
      b.position.set(bx, 0.35, zc - 3.4);
      root.add(b);
    }
  }

  // The pumphouse: a solid mid-west block both lanes must round.
  box(8, 3.4, 6, mat(0x77685a, 0.9), -14, 1.7, 0, root); solid(-18, -10, -3, 3, 3.4);
  box(8.6, 0.3, 6.6, mat(PAL.steelDark, 0.7, 0.3), -14, 3.55, 0, root);
  box(1.6, 2.2, 0.15, mat(0x2b2b30, 0.8), -14, 1.1, 3.05, root);
  box(2.6, 0.9, 0.15, glowMat(PAL.lampGlow, 1.4), -16.4, 2.4, 3.05, root);
  box(2.6, 0.9, 0.15, glowMat(PAL.lampGlow, 1.4), -11.6, 2.4, 3.05, root);

  // Container lanes.
  const C = PAL;
  container(root, -27, -5, 'z', 1, C.boxRed);
  container(root, -27, 6, 'z', 2, C.boxBlue);
  container(root, -19, -15, 'x', 1, C.boxGreen);
  container(root, -19, 15, 'x', 1, C.boxOchre);
  container(root, -13, -19, 'x', 2, C.boxBlue);
  container(root, -13, 19, 'x', 2, C.boxRed);
  container(root, -8, -7, 'z', 1, C.boxGrey);
  container(root, -8, 8, 'z', 1, C.boxGreen);
  container(root, 9, -7, 'z', 2, C.boxOchre);
  container(root, 9, 7, 'z', 1, C.boxRed);
  container(root, 13, -17, 'x', 1, C.boxBlue);
  container(root, 13, 17, 'x', 1, C.boxGreen);
  container(root, 15, -3, 'x', 1, C.boxGrey);
  container(root, 19, 3, 'z', 2, C.boxRed);
  container(root, 20, -20, 'x', 2, C.boxBlue);
  container(root, 30, -8, 'z', 1, C.boxGreen);
  container(root, 31, -19, 'x', 1, C.boxGrey);
  container(root, 20, 20, 'x', 1, C.boxRed);
  container(root, 30, 8, 'z', 2, C.boxOchre);
  container(root, 31, 19, 'x', 1, C.boxBlue);
  container(root, 15, 11, 'z', 1, C.boxGrey);

  // Crates and barrels as close cover.
  crate(root, 22, -11); crate(root, 26, -18, true); crate(root, 22, 12); crate(root, 27, 17);
  crate(root, -5, -16); crate(root, 5, 16); crate(root, -22, -1); crate(root, 24, 1, true);
  barrels(root, 10, -12); barrels(root, -16, 5.5); barrels(root, 28, -3); barrels(root, -2, -18);

  // The gantry crane over Site A: four legs, a top frame, a trolley and a hanging box.
  const craneMat = mat(0xc7742c, 0.55, 0.45);
  for (const [lx, lz] of [[18.5, -19.5], [29.5, -19.5], [18.5, -8.5], [29.5, -8.5]]) {
    box(0.9, 9.5, 0.9, craneMat, lx, 4.75, lz, root);
    solid(lx - 0.45, lx + 0.45, lz - 0.45, lz + 0.45, 9.5);
  }
  box(12.4, 0.9, 1.1, craneMat, 24, 9.6, -19.5, root);
  box(12.4, 0.9, 1.1, craneMat, 24, 9.6, -8.5, root);
  box(1.1, 0.9, 12.4, craneMat, 18.5, 9.6, -14, root);
  box(1.1, 0.9, 12.4, craneMat, 29.5, 9.6, -14, root);
  box(1.8, 1.2, 1.8, mat(PAL.steelDark, 0.6, 0.4), 24, 8.9, -14, root);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 3.1, 6), mat(0x222222, 0.5, 0.6));
  cable.position.set(24, 6.9, -14);
  root.add(cable);
  const hangSide = new THREE.MeshStandardMaterial({ map: containerTex || makeContainerTexture(), color: PAL.boxGreen, roughness: 0.75, metalness: 0.25 });
  box(2.44, 2.6, 6.1, hangSide, 24, 4.05, -14, root);

  // Site B: the gatehouse hut and the two leaves of the lock gate itself.
  box(6, 3, 4, mat(0x6b7a72, 0.9), 24, 1.5, 19.5, root); solid(21, 27, 17.5, 21.5, 3);
  box(6.5, 0.25, 4.5, mat(PAL.steelDark, 0.7, 0.3), 24, 3.1, 19.5, root);
  box(3.4, 1.0, 0.14, glowMat(PAL.lampGlow, 1.6), 24, 2.0, 17.42, root);
  box(0.14, 1.0, 2.4, glowMat(PAL.lampGlow, 1.2), 20.94, 2.0, 19.5, root);
  const gateMat = mat(0x51606a, 0.45, 0.7);
  box(2, 4.2, 3, gateMat, 30.5, 2.1, 11, root); solid(29.5, 31.5, 9.5, 12.5, 4.2);
  box(2, 4.2, 3, gateMat, 30.5, 2.1, 17, root); solid(29.5, 31.5, 15.5, 18.5, 4.2);
  for (const gz of [11, 17]) {
    for (let i = 0; i < 3; i++) box(2.1, 0.22, 2.6, mat(PAL.rust, 0.6, 0.4), 30.5, 0.9 + i * 1.3, gz, root);
  }
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.07, 8, 20), mat(PAL.rust, 0.5, 0.6));
  wheel.position.set(28.6, 2.6, 14);
  wheel.rotation.y = Math.PI / 2;
  root.add(wheel);
  box(0.5, 2.6, 0.5, mat(PAL.steelDark, 0.6, 0.5), 28.6, 1.3, 14, root); solid(28.35, 28.85, 13.75, 14.25, 2.6);

  // Lamps: two real lights at the bridges, two at the sites, the rest emissive only.
  lamp(root, scene, -4.8, -11, false); lamp(root, scene, 4.8, 11, false);
  lamp(root, scene, 0, -11, true); lamp(root, scene, 0, 11, true);
  lamp(root, scene, 17, -14, true); lamp(root, scene, 17, 14, true);
  lamp(root, scene, -22, -18, false); lamp(root, scene, -22, 18, false);
  lamp(root, scene, 33, 0, false);

  // Distant port silhouettes for the cover shot's depth: a moored ship to the north,
  // far stacks and a second crane to the east, all outside the walls.
  const far = new THREE.Group();
  root.add(far);
  box(34, 5, 7, mat(0x2c3844, 0.9), -8, 0.5, -38, far);
  box(10, 6, 6, mat(0x39434e, 0.9), -16, 6, -38, far);
  box(3, 9, 3, mat(0x39434e, 0.9), -4, 7.5, -38, far);
  box(12, 5.2, 2.44, mat(PAL.boxRed, 0.9), 22, 1.6, -33, far);
  box(12, 5.2, 2.44, mat(PAL.boxBlue, 0.9), 22, 6.8, -33, far);
  box(0.9, 15, 0.9, mat(0x54443a, 0.9), 46, 7.5, -12, far);
  box(0.9, 15, 0.9, mat(0x54443a, 0.9), 46, 7.5, 6, far);
  box(1.2, 1.2, 20, mat(0x54443a, 0.9), 46, 15, -3, far);

  return { root };
}

// ---- Actor figures ----------------------------------------------------------

const figureGeo = {
  torso: new THREE.CapsuleGeometry(0.17, 0.42, 3, 10),
  head: new THREE.SphereGeometry(0.115, 12, 10),
  leg: new THREE.BoxGeometry(0.15, 0.78, 0.17),
  arm: new THREE.BoxGeometry(0.11, 0.62, 0.11),
  gun: new THREE.BoxGeometry(0.07, 0.14, 0.78),
  vest: new THREE.BoxGeometry(0.4, 0.44, 0.26),
};

// A low-poly harbour worker with a rifle, in team colours. Parts are named so main.js can
// swing the legs, pitch the gun arm and lay the figure down when it dies.
export function makeFigure(team) {
  const bright = team === 'BRK' ? PAL.brk : PAL.wrd;
  const dark = team === 'BRK' ? PAL.brkDark : PAL.wrdDark;
  const g = new THREE.Group();
  const torso = new THREE.Mesh(figureGeo.torso, mat(dark, 0.85));
  torso.position.y = 1.18;
  g.add(torso);
  const vest = new THREE.Mesh(figureGeo.vest, mat(bright, 0.8));
  vest.position.set(0, 1.22, -0.03);
  g.add(vest);
  const head = new THREE.Mesh(figureGeo.head, mat(0x9a7a63, 0.7));
  head.position.y = 1.64;
  g.add(head);
  const cap = new THREE.Mesh(figureGeo.head, mat(bright, 0.8));
  cap.scale.set(1.04, 0.62, 1.04);
  cap.position.y = 1.70;
  g.add(cap);
  const legL = new THREE.Mesh(figureGeo.leg, mat(0x2f3338, 0.9));
  legL.position.set(-0.11, 0.42, 0);
  g.add(legL);
  const legR = new THREE.Mesh(figureGeo.leg, mat(0x2f3338, 0.9));
  legR.position.set(0.11, 0.42, 0);
  g.add(legR);
  // The gun arm is a pivot at the shoulder so it can track the actor's pitch.
  const armPivot = new THREE.Group();
  armPivot.position.set(0.22, 1.44, 0);
  const arm = new THREE.Mesh(figureGeo.arm, mat(dark, 0.85));
  arm.position.set(0, -0.2, -0.12);
  arm.rotation.x = 1.15;
  armPivot.add(arm);
  const gun = new THREE.Mesh(figureGeo.gun, mat(0x1d1f22, 0.5, 0.5));
  gun.position.set(0, -0.32, -0.5);
  armPivot.add(gun);
  const armL = new THREE.Mesh(figureGeo.arm, mat(dark, 0.85));
  armL.position.set(-0.24, 1.18, -0.1);
  armL.rotation.x = 0.9;
  g.add(armL);
  g.userData = { armPivot, legL, legR, torso, head };
  return g;
}
