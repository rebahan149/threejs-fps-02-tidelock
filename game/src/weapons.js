// weapons.js — the armoury: five guns with distinct jobs, armour, grenades and the
// defuse kit, all priced for the buy phase; and the shared combat maths — hitscan with
// head/leg zones, armour absorption, range falloff and movement spread — used identically
// for the player's shots and the bots'.

import { G, eyeOf, emit, awardActor, MONEY } from './state.js';
import { rayWorld, dirFrom, inSmoke } from './world.js';

// kind drives the sound and the view-model shape. falloffStart/falloffEnd bracket the
// range over which damage fades to falloffMin. head/leg are zone multipliers.
export const DEFS = {
  p9: {
    id: 'p9', name: 'P9 Sidearm', kind: 'pistol', price: 0, damage: 26, rpm: 340, mag: 12, reserve: 48,
    reload: 1.5, spread: 0.011, moveSpread: 0.05, falloffStart: 18, falloffEnd: 46, falloffMin: 0.5,
    head: 3.4, leg: 0.75, auto: false, pellets: 1, zoom: 0,
  },
  squall: {
    id: 'squall', name: 'Squall SMG', kind: 'smg', price: 1250, damage: 24, rpm: 780, mag: 30, reserve: 90,
    reload: 2.0, spread: 0.02, moveSpread: 0.075, falloffStart: 14, falloffEnd: 38, falloffMin: 0.45,
    head: 3.2, leg: 0.75, auto: true, pellets: 1, zoom: 0,
  },
  breaker: {
    id: 'breaker', name: 'Breaker Scattergun', kind: 'scatter', price: 1100, damage: 13, rpm: 68, mag: 6, reserve: 24,
    reload: 2.6, spread: 0.055, moveSpread: 0.03, falloffStart: 7, falloffEnd: 20, falloffMin: 0.3,
    head: 2.2, leg: 0.75, auto: false, pellets: 8, zoom: 0,
  },
  longline: {
    id: 'longline', name: 'Longline Rifle', kind: 'rifle', price: 2700, damage: 33, rpm: 600, mag: 30, reserve: 90,
    reload: 2.2, spread: 0.006, moveSpread: 0.09, falloffStart: 30, falloffEnd: 80, falloffMin: 0.65,
    head: 4.0, leg: 0.75, auto: true, pellets: 1, zoom: 0,
  },
  harpoon: {
    id: 'harpoon', name: 'Harpoon DMR', kind: 'dmr', price: 3100, damage: 62, rpm: 150, mag: 10, reserve: 30,
    reload: 2.4, spread: 0.0015, moveSpread: 0.12, falloffStart: 40, falloffEnd: 110, falloffMin: 0.8,
    head: 3.6, leg: 0.75, auto: false, pellets: 1, zoom: 2.6,
  },
};

export const GEAR = {
  vest: { id: 'vest', name: 'Kevlar Vest', price: 650 },
  helm: { id: 'helm', name: 'Vest + Helmet', price: 1000 },
  frag: { id: 'frag', name: 'Frag Charge', price: 300 },
  smoke: { id: 'smoke', name: 'Smoke Canister', price: 300 },
  flash: { id: 'flash', name: 'Flash Flare', price: 200 },
  kit: { id: 'kit', name: 'Defuse Kit', price: 200 },
};

export function freshWeapon(defId) {
  const d = DEFS[defId];
  return { def: d, mag: d.mag, reserve: d.reserve };
}

export function giveStartLoadout(actor) {
  actor.secondary = freshWeapon('p9');
  actor.primary = null;
  actor.slot = 'secondary';
  actor.frag = 0; actor.smoke = 0; actor.flash = 0;
  actor.defuseKit = false;
  actor.armour = 0;
  actor.helmet = false;
}

// One purchase; returns true when it went through. Money and stock rules live here so the
// human's buy menu and the bots' buy policy can never disagree.
export function buy(actor, itemId) {
  const gun = DEFS[itemId];
  if (gun) {
    if (actor.money < gun.price) return false;
    actor.money -= gun.price;
    if (itemId === 'p9') actor.secondary = freshWeapon('p9');
    else { actor.primary = freshWeapon(itemId); actor.slot = 'primary'; }
    return true;
  }
  const gear = GEAR[itemId];
  if (!gear || actor.money < gear.price) return false;
  switch (itemId) {
    case 'vest': if (actor.armour >= 1) return false; actor.armour = 1; break;
    case 'helm': if (actor.armour >= 2) return false; actor.armour = 2; actor.helmet = true; break;
    case 'frag': if (actor.frag >= 1) return false; actor.frag = 1; break;
    case 'smoke': if (actor.smoke >= 1) return false; actor.smoke = 1; break;
    case 'flash': if (actor.flash >= 2) return false; actor.flash += 1; break;
    case 'kit': if (actor.defuseKit || actor.team !== 'WRD') return false; actor.defuseKit = true; break;
    default: return false;
  }
  actor.money -= gear.price;
  return true;
}

// ---- Damage -----------------------------------------------------------------

function applyDamage(target, raw, zone, attacker) {
  if (!target.alive) return 0;
  let dmg = raw;
  // Armour absorbs half of body and leg damage; a helmet does the same for the head.
  if (target.armour > 0 && zone !== 'head') dmg *= 0.55;
  if (target.armour === 2 && zone === 'head') dmg *= 0.55;
  dmg = Math.max(1, Math.round(dmg));
  target.hp -= dmg;
  target.lastDamageAt = G.time;
  target.lastDamageFrom = attacker;
  if (attacker && attacker.isPlayer) emit('hitmark', { head: zone === 'head' });
  if (target.isPlayer) emit('hurt', {});
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.deaths += 1;
    if (attacker) {
      attacker.kills += 1;
      awardActor(attacker, MONEY.kill);
      if (attacker.isPlayer) emit('killconfirm', {});
    }
    emit('kill', { victim: target, attacker, head: zone === 'head' });
    // The charge changes hands by lying on the ground where its carrier fell.
    if (target.hasCharge) {
      target.hasCharge = false;
      G.charge.state = 'dropped';
      G.charge.carrier = null;
      G.charge.x = target.x;
      G.charge.z = target.z;
      emit('chargedrop', { x: target.x, z: target.z });
    }
    if (G.channel && G.channel.actor === target) G.channel = null;
  }
  return dmg;
}

// Ray vs one actor's two hit boxes (body and head). Returns { t, zone } or null.
function rayActor(ox, oy, oz, dx, dy, dz, a, maxDist) {
  const feet = a.y;
  const top = feet + (a.crouch ? 1.32 : 1.78);
  const headC = feet + (a.crouch ? 1.13 : 1.62);
  let best = null;
  // Body: a vertical box around the actor.
  const tb = rayBox(ox, oy, oz, dx, dy, dz, a.x - 0.31, feet, a.z - 0.31, a.x + 0.31, top - 0.22, a.z + 0.31);
  if (tb !== null && tb < maxDist) best = { t: tb, zone: 'body' };
  const th = rayBox(ox, oy, oz, dx, dy, dz, a.x - 0.13, headC - 0.13, a.z - 0.13, a.x + 0.13, headC + 0.13, a.z + 0.13);
  if (th !== null && th < maxDist && (!best || th < best.t)) best = { t: th, zone: 'head' };
  // Legs: the body's lower half, tagged so the caller can discount it.
  if (best && best.zone === 'body') {
    const hitY = oy + dy * best.t;
    if (hitY < feet + 0.72) best.zone = 'leg';
  }
  return best;
}

function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
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

// Fire one pellet of a hitscan shot. Spread is applied by the caller (bots pre-perturb
// their aim; the player gets spread from movement and recoil in player.js/main.js).
export function firePellet(shooter, yaw, pitch, def) {
  const eye = eyeOf(shooter);
  const d = dirFrom(yaw, pitch);
  const maxDist = 140;
  const wallT = rayWorld(shooter.x, eye, shooter.z, d.x, d.y, d.z, maxDist);
  let best = null;
  for (const a of G.actors) {
    if (a === shooter || !a.alive || a.team === shooter.team) continue;
    const hit = rayActor(shooter.x, eye, shooter.z, d.x, d.y, d.z, a, Math.min(wallT, maxDist));
    if (hit && (!best || hit.t < best.t)) best = { ...hit, actor: a };
  }
  const endT = best ? best.t : wallT;
  emit('tracer', {
    x0: shooter.x + d.x * 0.5, y0: eye - 0.12 + d.y * 0.5, z0: shooter.z + d.z * 0.5,
    x1: shooter.x + d.x * endT, y1: eye + d.y * endT, z1: shooter.z + d.z * endT,
    team: shooter.team,
  });
  if (!best) return null;
  const dist = best.t;
  let dmg = def.damage;
  if (best.zone === 'head') dmg *= def.head;
  else if (best.zone === 'leg') dmg *= def.leg;
  if (dist > def.falloffStart) {
    const f = Math.min(1, (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart));
    dmg *= 1 - f * (1 - def.falloffMin);
  }
  applyDamage(best.actor, dmg, best.zone, shooter);
  return best;
}

// Attempt to fire the actor's current weapon once (all pellets). Handles ammo, cadence
// and reload state; returns true when a shot actually left the barrel.
export function tryFire(actor, yaw, pitch, spreadScale = 1) {
  const w = actor.slot === 'primary' && actor.primary ? actor.primary : actor.secondary;
  if (!w || G.time < actor.nextShotAt || G.time < actor.reloadingUntil) return false;
  if (w.mag <= 0) {
    emit('dryfire', { byPlayer: actor.isPlayer, x: actor.x, z: actor.z });
    actor.nextShotAt = G.time + 0.3;
    startReload(actor);
    return false;
  }
  w.mag -= 1;
  actor.nextShotAt = G.time + 60 / w.def.rpm;
  actor.muzzleAt = G.time;
  const movePenalty = Math.min(1, actor.speedNow / 4.6);
  for (let p = 0; p < w.def.pellets; p++) {
    const spread = (w.def.spread + w.def.moveSpread * movePenalty) * spreadScale;
    const sy = yaw + (G.rng() * 2 - 1) * spread;
    const sp = pitch + (G.rng() * 2 - 1) * spread * 0.8;
    firePellet(actor, sy, sp, w.def);
  }
  emit('shot', { weaponKind: w.def.kind, byPlayer: actor.isPlayer, x: actor.x, z: actor.z, team: actor.team });
  G.noises.push({ x: actor.x, z: actor.z, r: 30, team: actor.team, kind: 'shot', at: G.time });
  return true;
}

export function startReload(actor) {
  const w = actor.slot === 'primary' && actor.primary ? actor.primary : actor.secondary;
  if (!w || G.time < actor.reloadingUntil || w.mag >= w.def.mag || w.reserve <= 0) return;
  actor.reloadingUntil = G.time + w.def.reload;
  actor.reloadEndsWith = w;
  emit('reload', { byPlayer: actor.isPlayer, x: actor.x, z: actor.z });
}

export function finishReload(actor) {
  const w = actor.reloadEndsWith;
  if (!w) return;
  const need = w.def.mag - w.mag;
  const take = Math.min(need, w.reserve);
  w.mag += take;
  w.reserve -= take;
  actor.reloadEndsWith = null;
}

// ---- Grenades ---------------------------------------------------------------

// kind: 'frag' | 'smoke' | 'flash'. A simple ballistic toss from the eye, fused short.
export function throwGrenade(actor, kind, yaw, pitch) {
  const count = kind === 'frag' ? actor.frag : kind === 'smoke' ? actor.smoke : actor.flash;
  if (count <= 0) return false;
  if (kind === 'frag') actor.frag -= 1;
  else if (kind === 'smoke') actor.smoke -= 1;
  else actor.flash -= 1;
  const d = dirFrom(yaw, Math.max(pitch, 0.12));
  const speed = 15;
  G.frags.push({
    kind,
    x: actor.x, y: eyeOf(actor), z: actor.z,
    vx: d.x * speed, vy: d.y * speed + 2.2, vz: d.z * speed,
    fuse: kind === 'frag' ? 1.5 : 1.1,
    team: actor.team, owner: actor,
  });
  return true;
}

// Advance grenades; on fuse end, apply their effect. Called by main.js each tick.
export function tickGrenades(dt) {
  for (let i = G.frags.length - 1; i >= 0; i--) {
    const f = G.frags[i];
    f.vy -= 16 * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    f.z += f.vz * dt;
    if (f.y < 0.12) { f.y = 0.12; f.vy *= -0.35; f.vx *= 0.7; f.vz *= 0.7; }
    f.fuse -= dt;
    if (f.fuse > 0) continue;
    G.frags.splice(i, 1);
    if (f.kind === 'frag') explodeFrag(f);
    else if (f.kind === 'smoke') {
      G.smokes.push({ x: f.x, z: f.z, r: 4.4, bornAt: G.time, until: G.time + 16 });
      emit('smoke', { x: f.x, z: f.z, byPlayer: f.owner.isPlayer });
      emit('smokepuff', { x: f.x, z: f.z });
    } else flashPop(f);
  }
  // Smoke clouds thin out on schedule.
  for (let i = G.smokes.length - 1; i >= 0; i--) {
    if (G.time > G.smokes[i].until) G.smokes.splice(i, 1);
  }
}

function explodeFrag(f) {
  emit('explosion', { x: f.x, z: f.z, byPlayer: f.owner.isPlayer });
  emit('boom', { x: f.x, y: 0.6, z: f.z });
  G.noises.push({ x: f.x, z: f.z, r: 40, team: f.team, kind: 'boom', at: G.time });
  for (const a of G.actors) {
    if (!a.alive) continue;
    const dx = a.x - f.x, dz = a.z - f.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 5.2) continue;
    // Cover counts: a wall between the blast and the actor halves it.
    const blocked = rayWorld(f.x, 0.7, f.z, dx / (dist || 1), 0.25, dz / (dist || 1), dist) < dist - 0.4;
    const dmg = 92 * (1 - dist / 5.6) * (blocked ? 0.4 : 1);
    if (dmg > 2) applyDamage(a, dmg, 'body', f.owner === a ? null : f.owner);
  }
}

function flashPop(f) {
  emit('flashpop', { x: f.x, z: f.z, byPlayer: f.owner.isPlayer });
  emit('flashburst', { x: f.x, y: 1.2, z: f.z });
  for (const a of G.actors) {
    if (!a.alive || a.team === f.team) continue;
    const dx = f.x - a.x, dz = f.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 17) continue;
    if (inSmoke(a.x, eyeOf(a), a.z)) continue;
    // Facing factor: looking at the pop blinds fully, looking away barely.
    const face = dirFrom(a.yaw, 0);
    const dot = (face.x * dx + face.z * dz) / (dist || 1);
    const strength = dot > 0.55 ? 1 : dot > 0.1 ? 0.45 : 0.12;
    const dur = strength * Math.max(0.4, 2.6 - dist * 0.1);
    a.blindUntil = Math.max(a.blindUntil ?? 0, G.time + dur);
    if (a.isPlayer) emit('blinded', { strength, dur });
  }
}
