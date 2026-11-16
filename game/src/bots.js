// bots.js — the nine bot brains: a team plan each round (an entry pair, a support, a
// lurker for the Breakers; anchors and a rotator for the Wardens), waypoint pathfinding,
// perception through view cones, line of sight, smoke and hearing, and a human-flavoured
// aim model — turning speed, settling error and bursts — so fights are won by position
// and timing, not by robot aim. The same brain drives the player in demo mode.

import { G, PHASE, eyeOf, weaponOf } from './state.js';
import { findPath, losBlocked, yawTo, dirFrom, SITES, inSmoke } from './world.js';
import { stepMovement } from './player.js';
import { tryFire, startReload, throwGrenade, buy } from './weapons.js';

const HOLDS = {
  A: [[19, -10.5], [27.5, -18], [21, -19.5], [30, -13]],
  B: [[19, 10.5], [27.5, 18], [21, 19.5], [30, 13]],
  MID: [[14, 0], [10.5, -3.5], [10.5, 3.5]],
};
const POST_PLANT = {
  A: [[17.5, -13], [24, -20.5], [29, -8.5], [20, -7.5]],
  B: [[17.5, 13], [24, 20.5], [29, 8.5], [20, 7.5]],
};

export function newBrain(role) {
  return {
    role,
    state: 'advance',
    path: [], pathI: 0,
    tx: 0, tz: 0, // current objective point
    holdYaw: 0, scanPhase: Math.random() * 6,
    thinkAt: Math.random() * 0.12,
    seen: null, seenAt: 0, firstSeenAt: 0, lastSeenX: 0, lastSeenZ: 0,
    hearX: null, hearZ: null,
    aimYaw: 0, aimPitch: 0, settle: 0,
    burst: 0, burstWaitUntil: 0,
    stuckAt: 0, lastX: 0, lastZ: 0,
    threwUtil: false,
    coverAt: 0,
  };
}

// ---- Round planning ---------------------------------------------------------

export function makePlan() {
  const siteId = G.rng() < 0.5 ? 'A' : 'B';
  const site = SITES[siteId];
  G.plan = { site: siteId, x: site.x, z: site.z };
  const brk = G.actors.filter((a) => a.team === 'BRK' && !a.isPlayer);
  const wrd = G.actors.filter((a) => a.team === 'WRD' && !a.isPlayer);
  // Breakers: carrier leads with one entry, one support trails with the utility,
  // one lurks toward the other site before rotating late.
  const roles = ['entry', 'entry', 'support', 'lurk'];
  brk.forEach((a, i) => {
    a.brain = newBrain(a.hasCharge ? 'carrier' : roles[i % roles.length]);
    const lane = a.brain.role === 'lurk' ? (siteId === 'A' ? 'B' : 'A') : siteId;
    const t = lane === 'A' ? { x: 16, z: -13 } : { x: 16, z: 13 };
    setTarget(a, t.x, t.z);
    if (a.brain.role === 'support') setTarget(a, site.x - 12, site.z * 0.8);
  });
  // Wardens: two anchor each site, one floats mid and rotates on information.
  const wRoles = ['anchorA', 'anchorA', 'anchorB', 'anchorB', 'rotate'];
  const shuffled = [...wrd].sort(() => G.rng() - 0.5);
  shuffled.forEach((a, i) => {
    const role = wRoles[i % wRoles.length];
    a.brain = newBrain(role);
    const holds = role === 'anchorA' ? HOLDS.A : role === 'anchorB' ? HOLDS.B : HOLDS.MID;
    const h = holds[i % holds.length];
    setTarget(a, h[0], h[1]);
    a.brain.holdYaw = yawTo(h[0], h[1], -10, h[1] * 0.6);
  });
  // The human gets no orders; the demo brain plays 'entry' for the camera.
  if (G.player && G.demo) {
    G.player.brain = newBrain(G.player.team === 'BRK' ? 'entry' : 'rotate');
    if (G.player.team === 'BRK') setTarget(G.player, site.x - 6, site.z);
    else setTarget(G.player, 14, 0);
  }
}

function setTarget(a, x, z) {
  a.brain.tx = x;
  a.brain.tz = z;
  a.brain.path = findPath(a.x, a.z, x, z);
  a.brain.pathI = 0;
  a.brain.state = 'advance';
}

// ---- Buying -----------------------------------------------------------------

export function botBuy(a) {
  const spend = (id) => buy(a, id);
  const m = a.money;
  if (m >= 3950) {
    spend('longline'); spend('helm'); spend('smoke'); spend('flash');
    if (a.brain && a.brain.role === 'support') spend('frag');
  } else if (m >= 3400) {
    spend('harpoon'); spend('vest'); spend('flash');
  } else if (m >= 2200) {
    spend(a.index % 2 ? 'squall' : 'breaker'); spend('vest'); spend('flash');
  } else if (m >= 1000) {
    spend('vest');
    if (a.team === 'WRD') spend('kit');
  } else if (m >= 650) {
    spend('vest');
  }
  if (a.team === 'WRD' && m >= 200) spend('kit');
}

// ---- Perception -------------------------------------------------------------

function perceive(a) {
  const b = a.brain;
  const eye = eyeOf(a);
  let bestSeen = null;
  for (const e of G.actors) {
    if (!e.alive || e.team === a.team) continue;
    const dx = e.x - a.x, dz = e.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 62) continue;
    // View cone: 115 degrees, plus a small proximity sense so nobody is snuck up on
    // from arm's length without a reaction.
    const ang = Math.abs(angDiff(a.yaw, yawTo(a.x, a.z, e.x, e.z)));
    if (ang > 1.0 && dist > 4) continue;
    if (inSmoke(a.x, eye, a.z) || inSmoke(e.x, eyeOf(e), e.z)) continue;
    if (losBlocked(a.x, eye, a.z, e.x, eyeOf(e) - 0.25, e.z)) continue;
    if (!bestSeen || dist < bestSeen.dist) bestSeen = { e, dist };
  }
  if (bestSeen) {
    if (b.seen !== bestSeen.e) b.firstSeenAt = G.time;
    b.seen = bestSeen.e;
    b.seenAt = G.time;
    b.lastSeenX = bestSeen.e.x;
    b.lastSeenZ = bestSeen.e.z;
  } else if (G.time - b.seenAt > 0.4) {
    b.seen = null;
  }
  // Hearing: enemy noise inside its radius gives a rough position to check.
  for (const n of G.noises) {
    if (n.team === a.team) continue;
    const d = Math.hypot(n.x - a.x, n.z - a.z);
    if (d < n.r) { b.hearX = n.x; b.hearZ = n.z; }
  }
}

export function angDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ---- The tick ---------------------------------------------------------------

export function tickBot(a, dt) {
  if (!a.alive) return;
  const b = a.brain;
  if (!b) return;
  b.thinkAt -= dt;
  if (b.thinkAt <= 0) {
    b.thinkAt = 0.12;
    perceive(a);
    decide(a);
  }
  act(a, dt);
}

function decide(a) {
  const b = a.brain;
  const ch = G.charge;

  // Channel states are owned by main.js; while channelling, stand still.
  if (G.channel && G.channel.actor === a) { b.state = 'channel'; return; }

  // The carrier plants when standing on the chosen site.
  if (a.hasCharge && G.phase === PHASE.LIVE) {
    const s = SITES[G.plan.site];
    if (Math.hypot(a.x - s.x, a.z - s.z) < s.r - 1) { b.state = 'plant'; return; }
    setTarget(a, s.x, s.z);
    b.state = 'advance';
    return;
  }
  // A dropped charge near an attacker gets picked back up.
  if (a.team === 'BRK' && ch.state === 'dropped' && G.phase === PHASE.LIVE) {
    if (Math.hypot(a.x - ch.x, a.z - ch.z) < 1.2) { /* main.js performs the pickup */ }
    else if (b.role !== 'lurk') { setTarget(a, ch.x, ch.z); b.state = 'advance'; return; }
  }

  if (ch.state === 'planted') {
    const s = SITES[ch.site];
    if (a.team === 'WRD') {
      // Nearest defender defuses; the rest take cover angles around the site.
      const mates = G.actors.filter((x) => x.team === 'WRD' && x.alive);
      const nearest = mates.reduce((p, x) => (Math.hypot(x.x - ch.x, x.z - ch.z) < Math.hypot(p.x - ch.x, p.z - ch.z) ? x : p), mates[0]);
      if (a === nearest) {
        if (Math.hypot(a.x - ch.x, a.z - ch.z) < 1.6 && !b.seen) { b.state = 'defuse'; return; }
        setTarget(a, ch.x, ch.z);
        b.state = b.seen ? 'engage' : 'advance';
        return;
      }
      const holds = POST_PLANT[ch.site];
      const h = holds[a.index % holds.length];
      setTarget(a, h[0] + 6, h[1]);
      b.state = b.seen ? 'engage' : 'advance';
      return;
    }
    // Attackers hold the plant from the post-plant angles.
    const holds = POST_PLANT[ch.site];
    const h = holds[a.index % holds.length];
    if (Math.hypot(a.x - h[0], a.z - h[1]) > 2.4) { setTarget(a, h[0], h[1]); b.state = 'advance'; }
    else b.state = b.seen ? 'engage' : 'hold';
    b.holdYaw = yawTo(a.x, a.z, s.x + 8, s.z);
    return;
  }

  if (b.seen) { b.state = 'engage'; return; }

  // Rotator and lurker react to information: a sighting, a noise, a charge event.
  if ((b.role === 'rotate' || b.role === 'lurk') && (b.hearX !== null)) {
    setTarget(a, b.hearX, b.hearZ);
    b.hearX = null;
    b.state = 'advance';
    return;
  }
  // Anchors drift back to their hold point; entry bots keep pushing the plan.
  const distT = Math.hypot(a.x - b.tx, a.z - b.tz);
  if (b.state === 'advance' && distT < 1.6) {
    b.state = 'hold';
    if (b.role === 'entry' || b.role === 'carrier') {
      // Entry bots who reached the staging point push into the site itself.
      const s = SITES[G.plan.site];
      setTarget(a, s.x - 3, s.z + (a.index % 2 ? 2.5 : -2.5));
    }
  } else if (b.state === 'hold' && b.role.startsWith('anchor')) {
    b.holdYaw = yawTo(a.x, a.z, -8, a.z * 0.7);
  } else if (b.state !== 'engage') {
    b.state = 'advance';
  }
}

// Movement, aiming and firing for one tick, from the brain's current state.
function act(a, dt) {
  const b = a.brain;
  const wish = { fx: 0, fz: 0, slow: false, crouch: false, jump: false };
  let wantFire = false;
  let faceYaw = a.yaw;
  a.crouch = false;

  const followPath = (speed) => {
    if (b.pathI >= b.path.length) {
      // Straight-line the last stretch to the target.
      const dx = b.tx - a.x, dz = b.tz - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.7) { wish.fx = dx / d; wish.fz = dz / d; faceYaw = yawTo(a.x, a.z, b.tx, b.tz); }
      return;
    }
    const wp = b.path[b.pathI];
    const dx = wp.x - a.x, dz = wp.z - a.z;
    if (Math.hypot(dx, dz) < 0.95) { b.pathI += 1; return; }
    wish.fx = dx; wish.fz = dz;
    faceYaw = yawTo(a.x, a.z, wp.x, wp.z);
    if (speed === 'walk') wish.slow = true;
  };

  if (b.state === 'channel' || b.state === 'plant' || b.state === 'defuse') {
    // Standing still, hands busy; main.js runs the channel itself.
    a.crouch = b.state !== 'plant';
  } else if (b.state === 'engage' && b.seen) {
    const e = b.seen;
    const dist = Math.hypot(e.x - a.x, e.z - a.z);
    faceYaw = yawTo(a.x, a.z, e.x, e.z);
    // Range discipline: close in when far, strafe mid-range, hold when near.
    if (dist > 24) followPath('run');
    else if (dist > 7) {
      const strafeDir = Math.sin(G.time * 0.9 + a.index * 2.1) > 0 ? 1 : -1;
      const f = dirFrom(faceYaw, 0);
      wish.fx = -f.z * strafeDir;
      wish.fz = f.x * strafeDir;
      wish.slow = false;
    } else a.crouch = a.index % 2 === 0;
    wantFire = true;
  } else if (b.state === 'hold') {
    b.scanPhase += dt * 0.7;
    faceYaw = b.holdYaw + Math.sin(b.scanPhase) * 0.55;
    a.crouch = b.role.startsWith('anchor') && a.index % 2 === 0;
  } else {
    followPath(a.team === 'WRD' ? 'walk' : 'run');
    a.crouch = false;
  }

  // Support utility: smoke the site mouth and flash over it as the entry crosses.
  if (b.role === 'support' && !b.threwUtil && G.phase === PHASE.LIVE && G.plan) {
    const s = SITES[G.plan.site];
    if (Math.hypot(a.x - s.x, a.z - s.z) < 17) {
      b.threwUtil = true;
      if (a.smoke > 0) throwGrenade(a, 'smoke', yawTo(a.x, a.z, s.x - 4, s.z), 0.28);
      if (a.flash > 0) setTimeout(() => a.alive && throwGrenade(a, 'flash', yawTo(a.x, a.z, s.x, s.z), 0.34), 350);
    }
  }

  // Aim: the brain's aim point chases the target with a limited turn rate, and its
  // error settles the longer the target stays visible and the stiller the bot stands.
  const reacting = G.time - b.firstSeenAt > 0.28;
  if (b.seen && reacting) {
    const e = b.seen;
    const dx = e.x - a.x, dz = e.z - a.z;
    const dist = Math.hypot(dx, dz);
    const chestY = e.y + (e.crouch ? 0.95 : 1.32);
    const wantYaw = yawTo(a.x, a.z, e.x, e.z);
    const wantPitch = Math.atan2(chestY - eyeOf(a), dist);
    const turn = 7.5 * dt;
    b.aimYaw += clamp(angDiff(b.aimYaw, wantYaw), -turn, turn);
    b.aimPitch += clamp(wantPitch - b.aimPitch, -turn, turn);
    b.settle = Math.min(1, b.settle + dt * 1.4);
    a.yaw = b.aimYaw;
    a.pitch = b.aimPitch;
  } else {
    b.settle = Math.max(0, b.settle - dt * 2);
    b.aimYaw = a.yaw = turnToward(a.yaw, faceYaw, 5.2 * dt);
    b.aimPitch = a.pitch = turnToward(a.pitch, 0, 3 * dt);
  }

  // Firing: bursts with pauses, only once the aim is roughly on and the reaction
  // delay has passed. Reloads happen out of the fight.
  const w = weaponOf(a);
  if (wantFire && b.seen && reacting && w) {
    const err = Math.abs(angDiff(b.aimYaw, yawTo(a.x, a.z, b.seen.x, b.seen.z)));
    if (G.time >= b.burstWaitUntil && err < 0.05 + b.settle * 0.05) {
      if (b.burst <= 0) b.burst = w.def.kind === 'dmr' || w.def.kind === 'scatter' ? 1 : 3 + Math.floor(G.rng() * 3);
      if (tryFire(a, b.aimYaw, b.aimPitch, 1 + err * 6)) {
        b.burst -= 1;
        if (b.burst <= 0) b.burstWaitUntil = G.time + 0.28 + G.rng() * 0.4;
      }
    }
  }
  if (w && w.mag === 0 && !b.seen) startReload(a);
  if (w && w.mag < w.def.mag * 0.3 && G.time - b.seenAt > 2.5) startReload(a);

  // Stuck detection: if the body is not moving while it wants to, repath.
  if ((wish.fx !== 0 || wish.fz !== 0) && a.speedNow < 0.35) {
    if (G.time - b.stuckAt > 1.1) {
      b.stuckAt = G.time;
      b.path = findPath(a.x, a.z, b.tx, b.tz);
      b.pathI = 0;
    }
  } else b.stuckAt = G.time;

  stepMovement(a, wish, dt);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function turnToward(cur, want, maxStep) {
  const d = angDiff(cur, want);
  return cur + clamp(d, -maxStep, maxStep);
}

// The demo brain drives the human's actor in screenshot/attract mode by writing the
// same wish the keyboard would — main.js routes it through stepMovement and firing.
export function demoWish(a, dt) {
  tickBot(a, dt);
}
