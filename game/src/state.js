// state.js — the one place TIDELOCK keeps its mutable world: the seeded RNG, the match
// constants, the central game state object and the actor factory. Simulation modules read
// and write G; rendering reads it. Nothing here touches the DOM or three.js.

export const TICK = 1 / 60; // fixed simulation step, seconds
export const EYE = 1.62; // standing eye height
export const EYE_CROUCH = 1.18;
export const RADIUS = 0.36; // character collision radius
export const HEIGHT = 1.78;
export const HEIGHT_CROUCH = 1.32;

export const PHASE = { BUY: 'buy', LIVE: 'live', PLANTED: 'planted', POST: 'post', OVER: 'over' };
export const BUY_TIME = 12;
export const ROUND_TIME = 100;
export const CHARGE_TIME = 35;
export const POST_TIME = 5;
export const PLANT_TIME = 3.2;
export const DEFUSE_TIME = 5;
export const DEFUSE_TIME_KIT = 2.5;
export const ROUNDS_TO_WIN = 7;
export const MAX_ROUNDS = 12;
export const HALF_AT = 6;

export const TEAM = {
  BRK: { id: 'BRK', name: 'Breakers', role: 'attack' },
  WRD: { id: 'WRD', name: 'Wardens', role: 'defend' },
};
export const otherTeam = (t) => (t === 'BRK' ? 'WRD' : 'BRK');

// A small deterministic RNG (mulberry32). One stream drives the whole match so a seed
// replays the same game — the screenshot harness depends on that.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rngRange = (rng, lo, hi) => lo + rng() * (hi - lo);
export const rngPick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

const BRK_NAMES = ['Vessel', 'Anchor', 'Sable', 'Rigger', 'Pilot'];
const WRD_NAMES = ['Keeper', 'Lantern', 'Bolard', 'Tidewell', 'Marshal'];

// An actor is a plain object; its three.js figure lives in actor.mesh and is posed by
// main.js each frame from these fields.
export function makeActor(team, index, isPlayer) {
  return {
    id: `${team}-${index}`,
    team,
    index,
    name: isPlayer ? 'You' : (team === 'BRK' ? BRK_NAMES : WRD_NAMES)[index],
    isPlayer: !!isPlayer,
    alive: true,
    hp: 100,
    armour: 0, // 0 none, 1 vest, 2 vest+helmet
    helmet: false,
    x: 0, y: 0, z: 0, // feet position; y is the jump offset, ground is 0
    vx: 0, vz: 0, vy: 0,
    yaw: 0, pitch: 0,
    crouch: false,
    onGround: true,
    speedNow: 0,
    // Loadout. weapon objects come from weapons.js DEFS; slots hold live state.
    primary: null,
    secondary: null,
    slot: 'primary', // 'primary' | 'secondary'
    frag: 0, smoke: 0, flash: 0,
    defuseKit: false,
    hasCharge: false,
    reloadingUntil: 0,
    nextShotAt: 0,
    scoped: false,
    money: 800,
    kills: 0, deaths: 0, assists: 0,
    // Bot brain scratch (unused for the human).
    brain: null,
    lastDamageAt: -99,
    lastDamageFrom: null,
    stepAt: 0,
    mesh: null,
    muzzleAt: 0,
  };
}

export const weaponOf = (actor) => (actor.slot === 'primary' && actor.primary ? actor.primary : actor.secondary);
export const eyeOf = (actor) => actor.y + (actor.crouch ? EYE_CROUCH : EYE);

// The whole match in one object. main.js owns the phase machine; everyone else reads G.
export const G = {
  rng: makeRng(7),
  time: 0, // simulation seconds since boot
  phase: PHASE.BUY,
  phaseT: BUY_TIME, // seconds left in the current phase
  round: 1,
  half: 1,
  score: { BRK: 0, WRD: 0 },
  lossStreak: { BRK: 0, WRD: 0 },
  actors: [],
  player: null,
  // The charge: carried, dropped or planted.
  charge: { state: 'carried', carrier: null, x: 0, z: 0, site: null, plantAt: 0, beepAt: 0 },
  channel: null, // { actor, kind: 'plant'|'defuse', t, need, site }
  smokes: [], // { x, z, r, until, bornAt }
  flashes: [], // transient, consumed by fx/audio the tick they appear
  frags: [], // live grenade projectiles { x,y,z, vx,vy,vz, fuse, team, owner }
  noises: [], // { x, z, r, team, kind, at } — hearing for bots, cleared each tick
  events: [], // HUD/audio events { kind, ... } drained by hud.js and audio.js each frame
  roundLog: [],
  winner: null, // match winner team id or 'draw'
  plan: null, // attacker team plan for the round, set by bots.js
  demo: false, // bot drives the player (screenshot / attract mode)
  over: false,
};

export function emit(kind, data = {}) {
  G.events.push({ kind, at: G.time, ...data });
}

// Economy numbers, CS-flavoured but our own.
export const MONEY = {
  start: 800,
  cap: 16000,
  kill: 300,
  plant: 300, // to the planter
  plantTeam: 800, // to every attacker when the charge goes down
  win: 2700,
  winElim: 3250,
  lossBase: 1400,
  lossStep: 500,
  lossCap: 3400,
};

export function award(team, amount) {
  for (const a of G.actors) if (a.team === team) a.money = Math.min(MONEY.cap, a.money + amount);
}
export function awardActor(actor, amount) {
  actor.money = Math.min(MONEY.cap, actor.money + amount);
}
