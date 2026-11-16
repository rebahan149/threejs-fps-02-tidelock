// main.js — TIDELOCK's entry point: builds the renderer and the harbour, owns the match
// (buy → live → planted → post, halves, economy, win checks), drives the human's actor
// from the keyboard intent or hands it to the demo brain, ticks every bot, and poses the
// figures and camera each frame. The simulation runs on a fixed 60 Hz step; rendering
// and HUD updates ride the browser's frame callback.

import * as THREE from 'three';
import {
  G, PHASE, TICK, BUY_TIME, ROUND_TIME, CHARGE_TIME, POST_TIME, PLANT_TIME, DEFUSE_TIME,
  DEFUSE_TIME_KIT, HALF_AT, ROUNDS_TO_WIN, MAX_ROUNDS, MONEY, makeActor,
  emit, award, awardActor, otherTeam, eyeOf, weaponOf, makeRng,
} from './state.js';
import { PAL, makeSkyTexture } from './palette.js';
import { buildWorld, buildGraph, makeFigure, SITES, SPAWNS, tickWorld, yawTo } from './world.js';
import { intent, initInput, takeLook, clearEdges, locked } from './input.js';
import { DEFS, buy, tryFire, startReload, finishReload, throwGrenade, tickGrenades, giveStartLoadout } from './weapons.js';
import { stepMovement } from './player.js';
import { tickBot, makePlan, botBuy } from './bots.js';
import { initFx, consumeFxEvents, updateFx, buildViewModels, updateViewModel } from './fx.js';
import { initHud, updateHud, consumeHudEvents, showBanner, BUY_ITEMS } from './hud.js';
import * as audio from './audio.js';

// ---- Boot -------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 7) || 7;
G.rng = makeRng(seed);
G.demo = params.has('demo') || params.has('shot');
const shotKind = params.get('shot');

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PAL.fog, 55, 185);
const skyTex = makeSkyTexture();
scene.background = skyTex;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromEquirectangular(skyTex).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.08, 420);
camera.rotation.order = 'YXZ';
scene.add(camera);

const hemi = new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(PAL.sun, 2.4);
sun.position.set(-38, 21, -14);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x88a6bb, 0.5);
fill.position.set(30, 24, 30);
scene.add(fill);

buildWorld(scene);
buildGraph();
initFx(scene);
buildViewModels(camera);

// ---- Actors -----------------------------------------------------------------

const actors = [];
for (let i = 0; i < 5; i++) actors.push(makeActor('BRK', i, i === 0));
for (let i = 0; i < 5; i++) actors.push(makeActor('WRD', i, false));
for (const a of actors) {
  a.homeTeam = a.team;
  if (!a.isPlayer) {
    a.mesh = makeFigure(a.team);
    scene.add(a.mesh);
  }
  giveStartLoadout(a);
}
G.actors = actors;
G.player = actors[0];
const player = G.player;

// ---- Match flow -------------------------------------------------------------

const stats = { shots: 0, kills: 0, plants: 0, rounds: 0 };
let contactCalled = { BRK: false, WRD: false };

function resetActorForRound(a) {
  const spawn = SPAWNS[a.team][a.index % SPAWNS[a.team].length];
  a.x = spawn[0];
  a.z = spawn[1];
  a.y = 0;
  a.vx = 0; a.vz = 0; a.vy = 0;
  a.yaw = a.team === 'BRK' ? Math.PI / 2 : -Math.PI / 2;
  a.pitch = 0;
  a.hp = 100;
  a.crouch = false;
  a.scoped = false;
  a.hasCharge = false;
  a.blindUntil = 0;
  a.reloadingUntil = 0;
  a.reloadEndsWith = null;
  if (!a.alive) giveStartLoadout(a); // the dead come back with a sidearm and no armour
  a.alive = true;
  // Survivors keep their guns; top their magazines back up for the new round.
  for (const w of [a.primary, a.secondary]) {
    if (w) { w.mag = w.def.mag; w.reserve = w.def.reserve; }
  }
}

function startRound() {
  for (const a of actors) resetActorForRound(a);
  G.smokes.length = 0;
  G.frags.length = 0;
  G.noises.length = 0;
  G.channel = null;
  contactCalled = { BRK: false, WRD: false };
  // The charge goes to a Breaker bot, so the human is free to fight around it.
  const carrier = actors.find((a) => a.team === 'BRK' && !a.isPlayer) ?? player;
  carrier.hasCharge = true;
  G.charge = { state: 'carried', carrier, x: carrier.x, z: carrier.z, site: null, plantAt: 0, beepAt: 0 };
  makePlan();
  G.phase = PHASE.BUY;
  G.phaseT = BUY_TIME;
  stats.rounds += 1;
  for (const a of actors) if (!a.isPlayer) botBuy(a);
  const site = SITES[G.plan.site];
  emit('radio', { team: 'BRK', who: 'Vessel', text: `Pushing ${G.plan.site} — ${site.name}.` });
  emit('radio', { team: 'WRD', who: 'Keeper', text: 'Hold the sites, call your contacts.' });
  if (G.round > 1) showBanner(`ROUND ${G.round}`, `Breakers ${G.score.BRK} — ${G.score.WRD} Wardens`, 2);
}

// Rebuild an actor's figure in its (possibly new) team's colours.
function refigure(a) {
  if (!a.mesh) return;
  scene.remove(a.mesh);
  a.mesh = makeFigure(a.team);
  scene.add(a.mesh);
}

function swapSides() {
  for (const a of actors) {
    a.team = otherTeam(a.team);
    a.money = MONEY.start;
    a.alive = false; // forces a fresh loadout in resetActorForRound
    refigure(a);
  }
  const s = G.score.BRK;
  G.score.BRK = G.score.WRD;
  G.score.WRD = s;
  G.lossStreak = { BRK: 0, WRD: 0 };
  G.half = 2;
}

function startMatch() {
  G.score = { BRK: 0, WRD: 0 };
  G.round = 1;
  G.half = 1;
  G.over = false;
  G.winner = null;
  for (const a of actors) {
    a.team = a.homeTeam;
    a.money = MONEY.start;
    a.kills = 0; a.deaths = 0;
    a.alive = false;
    refigure(a);
  }
  startRound();
}

function endRound(winnerTeam, kind) {
  const loser = otherTeam(winnerTeam);
  G.score[winnerTeam] += 1;
  const elim = kind === 'elim';
  award(winnerTeam, elim ? MONEY.winElim : MONEY.win);
  G.lossStreak[winnerTeam] = 0;
  G.lossStreak[loser] += 1;
  award(loser, Math.min(MONEY.lossCap, MONEY.lossBase + MONEY.lossStep * (G.lossStreak[loser] - 1)));
  G.phase = PHASE.POST;
  G.phaseT = POST_TIME;
  G.channel = null;
  const won = player.team === winnerTeam;
  emit('roundwin', { won });
  const label = {
    elim: 'ELIMINATION', time: 'TIME — SITE HELD', detonate: 'CHARGE DETONATED',
    defuse: 'CHARGE DEFUSED', objective: 'OBJECTIVE',
  }[kind] ?? 'ROUND';
  showBanner(won ? 'ROUND WON' : 'ROUND LOST', `${winnerTeam === 'BRK' ? 'Breakers' : 'Wardens'} · ${label}`, 3.4);
  emit('radio', { team: winnerTeam, who: 'Keeper', text: 'Round ours. Reset and go again.' });
}

function checkMatchEnd() {
  if (G.score.BRK >= ROUNDS_TO_WIN || G.score.WRD >= ROUNDS_TO_WIN || G.round >= MAX_ROUNDS) {
    G.winner = G.score.BRK === G.score.WRD ? 'draw' : G.score.BRK > G.score.WRD ? 'BRK' : 'WRD';
    G.over = true;
    G.phase = PHASE.OVER;
    showBanner(
      G.winner === 'draw' ? 'MATCH DRAWN' : `${G.winner === 'BRK' ? 'BREAKERS' : 'WARDENS'} TAKE THE HARBOUR`,
      `Final score ${G.score.BRK} — ${G.score.WRD} · click to play again`,
      8,
    );
    return true;
  }
  return false;
}

// ---- Channels: planting and defusing ----------------------------------------

function channelUseHeld(a) {
  if (a.isPlayer && !G.demo) return intent.use;
  // A bot mid-channel reports state 'channel' (bots.js hands the state to main.js
  // while a channel runs); that still means "use held" — without it the channel
  // would cancel itself one tick after starting and no bot could ever plant.
  return a.brain && (a.brain.state === 'plant' || a.brain.state === 'defuse' || a.brain.state === 'channel');
}

function siteAt(x, z) {
  for (const s of [SITES.A, SITES.B]) {
    if (Math.hypot(x - s.x, z - s.z) < s.r) return s;
  }
  return null;
}

function tickChannel(dt) {
  const ch = G.channel;
  if (ch) {
    const a = ch.actor;
    const stillOk = a.alive && a.speedNow < 0.7 && channelUseHeld(a) &&
      (ch.kind === 'plant' ? siteAt(a.x, a.z)?.id === ch.site : Math.hypot(a.x - G.charge.x, a.z - G.charge.z) < 2.4);
    if (!stillOk) {
      G.channel = null;
    } else {
      ch.t += dt;
      if (ch.kind === 'defuse' && (a.isPlayer || Math.hypot(player.x - a.x, player.z - a.z) < 14)) {
        ch.tickAt = (ch.tickAt ?? 0) - dt;
        if (ch.tickAt <= 0) { ch.tickAt = 0.28; emit('defusetick', {}); }
      }
      if (ch.t >= ch.need) {
        G.channel = null;
        if (ch.kind === 'plant') completePlant(a, ch.site);
        else completeDefuse(a);
      }
      return;
    }
  }
  // Start a channel for anyone holding use in the right place.
  for (const a of actors) {
    if (!a.alive || !channelUseHeld(a)) continue;
    if (a.hasCharge && G.phase === PHASE.LIVE) {
      const s = siteAt(a.x, a.z);
      if (s) {
        G.channel = { actor: a, kind: 'plant', t: 0, need: PLANT_TIME, site: s.id };
        // A planter who has to restart (a stumble on the way in) calls it once.
        if (G.time - (a.plantCallAt ?? -99) > 5) {
          a.plantCallAt = G.time;
          emit('radio', { team: 'BRK', who: a.name, text: `Planting at ${s.id} — cover me!` });
        }
        return;
      }
    }
    if (a.team === 'WRD' && G.charge.state === 'planted' && Math.hypot(a.x - G.charge.x, a.z - G.charge.z) < 2.2) {
      G.channel = { actor: a, kind: 'defuse', t: 0, need: a.defuseKit ? DEFUSE_TIME_KIT : DEFUSE_TIME, site: G.charge.site };
      if (G.time - (a.defuseCallAt ?? -99) > 5) {
        a.defuseCallAt = G.time;
        emit('radio', { team: 'WRD', who: a.name, text: 'Defusing — keep them off me!' });
      }
      return;
    }
  }
}

function completePlant(a, siteId) {
  a.hasCharge = false;
  G.charge.state = 'planted';
  G.charge.carrier = null;
  G.charge.site = siteId;
  G.charge.x = a.x;
  G.charge.z = a.z;
  G.charge.plantAt = G.time;
  G.charge.beepAt = G.time + 1;
  G.phase = PHASE.PLANTED;
  awardActor(a, MONEY.plant);
  award('BRK', MONEY.plantTeam);
  stats.plants += 1;
  emit('planted', { site: siteId });
  emit('radio', { team: 'WRD', who: 'Lantern', text: `Charge is down at ${siteId} — retake, now!` });
}

function completeDefuse(a) {
  G.charge.state = 'defused';
  emit('defused', {});
  endRound('WRD', 'defuse');
}

// ---- Win checks ---------------------------------------------------------------

const aliveCount = (t) => actors.filter((a) => a.team === t && a.alive).length;

function tickPhase(dt) {
  G.phaseT -= dt;
  if (G.phase === PHASE.BUY) {
    if (G.phaseT <= 0) { G.phase = PHASE.LIVE; G.phaseT = ROUND_TIME; }
    return;
  }
  if (G.phase === PHASE.LIVE) {
    if (aliveCount('WRD') === 0) return endRound('BRK', 'elim');
    if (aliveCount('BRK') === 0) return endRound('WRD', 'elim');
    if (G.phaseT <= 0) return endRound('WRD', 'time');
    return;
  }
  if (G.phase === PHASE.PLANTED) {
    if (aliveCount('WRD') === 0) return endRound('BRK', 'elim');
    // Attackers all down: the charge still ticks; the Wardens must finish the defuse.
    if (G.time >= G.charge.beepAt) {
      const remain = G.charge.plantAt + CHARGE_TIME - G.time;
      emit('beep', { fast: remain < 8 });
      G.charge.beepAt = G.time + (remain < 8 ? 0.5 : remain < 20 ? 1 : 2);
    }
    if (G.time - G.charge.plantAt >= CHARGE_TIME) {
      emit('explosion', { x: G.charge.x, z: G.charge.z, byPlayer: false });
      emit('boom', { x: G.charge.x, y: 1, z: G.charge.z });
      G.charge.state = 'detonated';
      return endRound('BRK', 'detonate');
    }
    return;
  }
  if (G.phase === PHASE.POST) {
    if (G.phaseT <= 0) {
      if (checkMatchEnd()) return;
      G.round += 1;
      if (G.round === HALF_AT + 1) {
        swapSides();
        showBanner('HALF TIME', 'Sides swap — Breakers defend, Wardens attack', 3.4);
      }
      startRound();
    }
  }
}

// ---- The human's hands --------------------------------------------------------

let prevFire = false;
let recoil = 0;
let currentFov = 70;

function drivePlayer(dt) {
  const p = player;
  if (G.demo) {
    if (p.alive && G.phase !== PHASE.BUY) tickBot(p, dt);
    prevFire = false;
    return;
  }
  if (!p.alive) { clearEdges(); return; }
  const look = takeLook();
  if (locked) {
    p.yaw += look.dx * 0.0023;
    p.pitch -= look.dy * 0.0023;
    p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch));
  }
  // Slot switching and buying.
  if (intent.slot === 1 && p.primary) { p.slot = 'primary'; p.reloadingUntil = 0; p.reloadEndsWith = null; }
  if (intent.slot === 2 && p.secondary) { p.slot = 'secondary'; p.reloadingUntil = 0; p.reloadEndsWith = null; }
  if (intent.buyKey && G.phase === PHASE.BUY) {
    const item = BUY_ITEMS.find((i) => i.key === intent.buyKey);
    if (item) emit(buy(p, item.id) ? 'buy' : 'denied', {});
  }
  const f = { x: Math.sin(p.yaw), z: -Math.cos(p.yaw) };
  const r = { x: Math.cos(p.yaw), z: Math.sin(p.yaw) };
  const wish = {
    fx: f.x * intent.fwd + r.x * intent.strafe,
    fz: f.z * intent.fwd + r.z * intent.strafe,
    slow: intent.sprint,
    crouch: intent.crouch,
    jump: intent.jump,
  };
  p.crouch = intent.crouch;
  p.scoped = !!(weaponOf(p)?.def.zoom && intent.aim);
  if (p.scoped) wish.slow = true;
  stepMovement(p, wish, dt);

  // Firing: automatics run while held; the rest need a fresh click.
  const w = weaponOf(p);
  if (w && intent.fire && G.phase !== PHASE.BUY) {
    if (w.def.auto || !prevFire) {
      const scale = p.scoped ? 0.25 : intent.aim ? 0.8 : 1;
      if (tryFire(p, p.yaw, p.pitch + recoil * 0.4, scale * (p.crouch ? 0.85 : 1))) {
        recoil = Math.min(0.05, recoil + (w.def.kind === 'dmr' ? 0.03 : w.def.kind === 'scatter' ? 0.034 : w.def.kind === 'rifle' ? 0.011 : 0.008));
      }
    }
  }
  prevFire = intent.fire;
  if (intent.reload) startReload(p);
  if (intent.throwFrag) throwGrenade(p, 'frag', p.yaw, p.pitch);
  if (intent.throwSmoke) throwGrenade(p, 'smoke', p.yaw, p.pitch);
  if (intent.throwFlash) throwGrenade(p, 'flash', p.yaw, p.pitch);
  clearEdges();
}

// ---- One simulation tick ------------------------------------------------------

function tick(dt) {
  G.time += dt;
  tickPhase(dt);
  if (G.phase === PHASE.OVER) return;

  // Charge pickup: a Breaker walking over the dropped charge takes it.
  if (G.charge.state === 'dropped') {
    for (const a of actors) {
      if (a.alive && a.team === 'BRK' && Math.hypot(a.x - G.charge.x, a.z - G.charge.z) < 1.25) {
        a.hasCharge = true;
        G.charge.state = 'carried';
        G.charge.carrier = a;
        emit('chargepickup', { byPlayer: a.isPlayer });
        break;
      }
    }
  }

  drivePlayer(dt);
  // Freeze time: bots hold at spawn during the buy phase, like the real thing.
  if (G.phase !== PHASE.BUY) {
    for (const a of actors) if (!a.isPlayer) tickBot(a, dt);
  }
  tickChannel(dt);
  tickGrenades(dt);

  for (const a of actors) {
    if (a.reloadEndsWith && G.time >= a.reloadingUntil) finishReload(a);
  }
  // First-contact radio calls, once per team per round.
  for (const a of actors) {
    if (!a.isPlayer && a.brain?.seen && !contactCalled[a.team]) {
      contactCalled[a.team] = true;
      const near = Math.abs(a.z) < 8 ? 'mid' : a.z < 0 ? 'A side' : 'B side';
      emit('radio', { team: a.team, who: a.name, text: `Contact ${near}!` });
    }
  }
  G.noises.length = 0;
  recoil = Math.max(0, recoil - dt * 0.09);
}

// ---- Posing and camera --------------------------------------------------------

const walkPhase = new Map();
function poseActors() {
  for (const a of actors) {
    if (!a.mesh) continue;
    const m = a.mesh;
    m.position.set(a.x, a.y, a.z);
    m.rotation.y = -a.yaw;
    const ud = m.userData;
    if (!a.alive) {
      m.rotation.x = Math.max(-Math.PI / 2, m.rotation.x - 0.12);
      m.position.y = 0.16;
      continue;
    }
    m.rotation.x = 0;
    const ph = (walkPhase.get(a.id) ?? 0) + a.speedNow * 0.16;
    walkPhase.set(a.id, ph);
    const swing = Math.sin(ph) * Math.min(0.65, a.speedNow * 0.16);
    if (ud.legL) ud.legL.rotation.x = swing;
    if (ud.legR) ud.legR.rotation.x = -swing;
    if (ud.armPivot) ud.armPivot.rotation.x = a.pitch;
    const crouchDip = a.crouch ? 0.34 : 0;
    m.position.y = a.y - crouchDip * 0.4;
    if (ud.torso) ud.torso.position.y = 1.18 - crouchDip;
    if (ud.head) ud.head.position.y = 1.64 - crouchDip;
  }
}

function poseCamera() {
  const p = player;
  let view = p;
  if (!p.alive) {
    view = actors.find((a) => a.team === p.team && a.alive) ?? actors.find((a) => a.alive) ?? p;
  }
  const eye = eyeOf(view);
  camera.position.set(view.x, eye, view.z);
  camera.rotation.set(view.pitch + (view === p ? recoil : 0), -view.yaw, 0);
  const wantFov = view === p && p.scoped && weaponOf(p) ? 70 / weaponOf(p).def.zoom : 70;
  currentFov += (wantFov - currentFov) * 0.35;
  if (Math.abs(currentFov - camera.fov) > 0.05) {
    camera.fov = currentFov;
    camera.updateProjectionMatrix();
  }
}

// ---- Frame loop ---------------------------------------------------------------

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

initHud();
initInput(canvas, () => {
  audio.initAudio();
  audio.resumeAudio();
  if (G.phase === PHASE.OVER) startMatch();
});
if (G.demo) {
  audio.initAudio();
  document.getElementById('start').style.display = 'none';
}

startMatch();
if (shotKind) stageShot(shotKind);
audio.startAmbience(G.rng);

let last = performance.now();
let acc = 0;
function frame() {
  requestAnimationFrame(frame);
  // Elapsed time is measured on the performance.now() wall clock rather than the
  // frame callback's timestamp: the two are not guaranteed to share an origin or a
  // rate in every browser, and the accumulator must never be fed a negative step.
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt < 0) dt = 0;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  while (acc >= TICK) {
    tick(TICK);
    acc -= TICK;
  }
  const events = G.events.splice(0);
  for (const e of events) {
    if (e.kind === 'shot') stats.shots += 1;
    else if (e.kind === 'kill') stats.kills += 1;
  }
  consumeFxEvents(events);
  consumeHudEvents(events);
  audio.playEvents(events, (e) => (e.x !== undefined ? Math.hypot(e.x - player.x, e.z - player.z) : 0));
  poseActors();
  poseCamera();
  tickWorld(dt);
  updateFx(dt);
  const w = weaponOf(player);
  updateViewModel(
    player.alive ? (w ? w.def.kind : 'pistol') : null,
    dt,
    player.speedNow > 0.4,
    player.speedNow,
    player.muzzleAt,
    G.time < player.reloadingUntil,
    player.scoped,
  );
  updateHud();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// A small handle for the screenshot harness and curious players: live match state.
window.TIDELOCK = { G, stats, version: 'tidelock-1' };

// ---- Screenshot staging -------------------------------------------------------
// In shot mode the match is dealt out mid-action around the requested view, so a still
// frame shows the game being played: a plan in motion, a firefight, a plant to defend.

function stageShot(kind) {
  // Everyone carries rifles; the buy phase is skipped.
  for (const a of actors) {
    a.money = 6000;
    buy(a, a.team === 'BRK' || a.index % 2 === 0 ? 'longline' : 'harpoon');
    buy(a, 'helm');
  }
  G.phase = PHASE.LIVE;
  G.phaseT = ROUND_TIME;
  const put = (a, x, z, yaw) => { a.x = x; a.z = z; a.yaw = yaw; if (a.brain) { a.brain.tx = x; a.brain.tz = z; a.brain.path = []; a.brain.state = 'hold'; a.brain.holdYaw = yaw; } };
  const brk = actors.filter((a) => a.team === 'BRK');
  const wrd = actors.filter((a) => a.team === 'WRD');
  if (kind === 'cover') {
    put(player, -4.5, -11, Math.PI / 2);
    if (player.brain) { player.brain.state = 'hold'; player.brain.holdYaw = Math.PI / 2; }
    // The Wardens hold the far bank with SMGs here, so the bridge push survives
    // long enough to be photographed.
    for (const w of actors) if (w.team === 'WRD') buy(w, 'squall');
    put(brk[1], 6, -14, Math.PI / 2); put(brk[2], 10, -9, Math.PI / 2);
    put(brk[3], -2, 6, Math.PI / 2); put(brk[4], -12, -16, Math.PI / 2);
    put(wrd[0], 22, -16, -Math.PI / 2); put(wrd[1], 27, -11, -Math.PI / 2);
    put(wrd[2], 14, -3, -Math.PI / 2); put(wrd[3], 24, 12, -Math.PI / 2); put(wrd[4], 30, 16, -Math.PI / 2);
  } else if (kind === 'sitea') {
    put(player, 19, -14, Math.PI / 2);
    if (player.brain) { player.brain.state = 'hold'; player.brain.holdYaw = Math.PI / 2; }
    put(brk[1], 13, -12, Math.PI / 2); put(brk[2], 19, -8, Math.PI / 2);
    put(brk[3], 8, -15, Math.PI / 2); put(brk[4], -6, 10, Math.PI / 2);
    put(wrd[0], 25, -13, -Math.PI / 2); put(wrd[1], 28, -18, -Math.PI / 2);
    put(wrd[2], 21, -20, -Math.PI / 2); put(wrd[3], 18, 4, -Math.PI / 2); put(wrd[4], 28, 14, -Math.PI / 2);
  } else if (kind === 'fight') {
    G.plan = { site: 'B', x: SITES.B.x, z: SITES.B.z };
    put(player, 7.5, 4.5, -Math.PI / 2 - 0.5);
    if (player.brain) { player.brain.state = 'hold'; player.brain.holdYaw = -Math.PI / 2 - 0.5; }
    put(brk[1], 11, 8, -Math.PI / 2); put(brk[2], 5, 12, -Math.PI / 2);
    put(brk[3], -8, -6, Math.PI / 2); put(brk[4], 16, -6, Math.PI / 2);
    put(wrd[0], -6, 9, Math.PI / 2); put(wrd[1], -11, 3, Math.PI / 2);
    put(wrd[2], 2, 14, 0); put(wrd[3], 20, 14, -Math.PI / 2); put(wrd[4], 24, -14, -Math.PI / 2);
  } else if (kind === 'plant') {
    // The charge is already down at B; the Wardens are coming in to retake it.
    const carrier = G.charge.carrier;
    if (carrier) carrier.hasCharge = false;
    G.charge = { state: 'planted', carrier: null, x: 24, z: 13, site: 'B', plantAt: G.time - 5, beepAt: G.time + 1 };
    G.phase = PHASE.PLANTED;
    put(player, 18, 9.5, Math.PI / 2 + 0.3);
    if (player.brain) { player.brain.state = 'hold'; player.brain.holdYaw = Math.PI / 2 + 0.3; }
    put(brk[1], 21, 17, Math.PI / 2); put(brk[2], 28, 10, -0.6);
    put(brk[3], 15, 14, Math.PI / 2); put(brk[4], -4, -8, Math.PI / 2);
    put(wrd[0], 26, 15.5, -Math.PI / 2); put(wrd[1], 20, 12, Math.PI / 2);
    put(wrd[2], 12, 16, Math.PI / 2); put(wrd[3], 30, 20, -Math.PI / 2); put(wrd[4], 8, -2, Math.PI / 2);
    if (wrd[0].brain) { wrd[0].brain.state = 'advance'; wrd[0].brain.tx = 24; wrd[0].brain.tz = 13; }
  }
}
