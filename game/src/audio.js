// audio.js — every sound in TIDELOCK is synthesised with WebAudio: no audio files, no
// network. Short noise bursts and shaped oscillators stand in for gunfire, the charge's
// beeper, radio blips and the dusk harbour's gulls-and-buoys ambience.

let ctx = null;
let master = null;
let noiseBuf = null;

export function initAudio() {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return;
  }
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  const len = ctx.sampleRate * 1;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
}

export function resumeAudio() {
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function env(gain, t0, peak, decay) {
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
}

function noise({ dur = 0.1, freq = 1800, q = 0.8, peak = 0.5, type = 'bandpass', slideTo = null, delay = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t0, peak, dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.05);
}

function tone({ freq = 440, dur = 0.12, peak = 0.25, type = 'sine', slideTo = null, delay = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  const g = ctx.createGain();
  env(g, t0, peak, dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// Distance falloff for world sounds: full volume at the listener, gone by maxDist.
const vol = (dist, maxDist) => Math.max(0, 1 - dist / maxDist);

export function playShot(kind, dist = 0) {
  const v = dist === 0 ? 1 : vol(dist, 70);
  if (v <= 0.01) return;
  if (kind === 'scatter') {
    noise({ dur: 0.22, freq: 900, peak: 0.85 * v, type: 'lowpass' });
    noise({ dur: 0.08, freq: 3200, peak: 0.4 * v });
  } else if (kind === 'dmr') {
    noise({ dur: 0.16, freq: 1400, peak: 0.8 * v, type: 'lowpass' });
    tone({ freq: 160, dur: 0.14, peak: 0.5 * v, type: 'triangle', slideTo: 55 });
  } else if (kind === 'smg') {
    noise({ dur: 0.07, freq: 2400, peak: 0.55 * v });
    tone({ freq: 210, dur: 0.06, peak: 0.3 * v, type: 'triangle', slideTo: 90 });
  } else {
    noise({ dur: 0.11, freq: 1900, peak: 0.7 * v });
    tone({ freq: 180, dur: 0.09, peak: 0.4 * v, type: 'triangle', slideTo: 70 });
  }
  // A faint harbour echo off the water and containers.
  if (dist < 30) noise({ dur: 0.2, freq: 500, peak: 0.12 * v, type: 'lowpass', delay: 0.09 });
}

export function playDryFire() {
  tone({ freq: 1400, dur: 0.03, peak: 0.15, type: 'square' });
}
export function playReload() {
  noise({ dur: 0.05, freq: 900, peak: 0.25 });
  noise({ dur: 0.05, freq: 600, peak: 0.3, delay: 0.22 });
  noise({ dur: 0.06, freq: 1200, peak: 0.35, delay: 0.45 });
}
export function playHit(head) {
  tone({ freq: head ? 1900 : 1250, dur: 0.06, peak: 0.3, type: 'square' });
}
export function playKillConfirm() {
  tone({ freq: 880, dur: 0.07, peak: 0.25, type: 'square' });
  tone({ freq: 1320, dur: 0.1, peak: 0.25, type: 'square', delay: 0.07 });
}
export function playHurt() {
  tone({ freq: 140, dur: 0.16, peak: 0.4, type: 'sawtooth', slideTo: 70 });
}
export function playStep(dist = 0) {
  const v = dist === 0 ? 0.16 : vol(dist, 16) * 0.3;
  if (v <= 0.01) return;
  noise({ dur: 0.05, freq: 420, peak: v, type: 'lowpass' });
}
export function playJumpLand() {
  noise({ dur: 0.08, freq: 300, peak: 0.25, type: 'lowpass' });
}
export function playBeep(fast = false) {
  tone({ freq: 1560, dur: 0.07, peak: 0.3, type: 'square' });
  if (fast) tone({ freq: 1560, dur: 0.07, peak: 0.3, type: 'square', delay: 0.12 });
}
export function playPlanted() {
  for (let i = 0; i < 3; i++) tone({ freq: 1180, dur: 0.09, peak: 0.3, type: 'square', delay: i * 0.13 });
}
export function playExplosion(dist = 0) {
  const v = dist === 0 ? 1 : vol(dist, 90);
  if (v <= 0.01) return;
  noise({ dur: 0.9, freq: 300, peak: 1.0 * v, type: 'lowpass', slideTo: 60 });
  tone({ freq: 90, dur: 0.8, peak: 0.8 * v, type: 'sine', slideTo: 34 });
}
export function playFlashPop(dist = 0) {
  const v = dist === 0 ? 0.8 : vol(dist, 40);
  if (v <= 0.01) return;
  noise({ dur: 0.06, freq: 4000, peak: 0.5 * v, type: 'highpass' });
  tone({ freq: 2400, dur: 0.3, peak: 0.12 * v, slideTo: 1800 });
}
export function playSmokeHiss(dist = 0) {
  const v = dist === 0 ? 0.5 : vol(dist, 30);
  if (v <= 0.01) return;
  noise({ dur: 0.7, freq: 2600, peak: 0.22 * v, type: 'highpass' });
}
export function playRadioBlip() {
  tone({ freq: 1040, dur: 0.05, peak: 0.16, type: 'square' });
  tone({ freq: 780, dur: 0.05, peak: 0.12, type: 'square', delay: 0.06 });
}
export function playBuy() {
  tone({ freq: 660, dur: 0.05, peak: 0.2, type: 'square' });
  tone({ freq: 990, dur: 0.07, peak: 0.2, type: 'square', delay: 0.05 });
}
export function playDenied() {
  tone({ freq: 220, dur: 0.12, peak: 0.25, type: 'square' });
}
export function playRoundWin(won) {
  const base = won ? 523 : 392;
  tone({ freq: base, dur: 0.14, peak: 0.25, type: 'triangle' });
  tone({ freq: base * 1.25, dur: 0.14, peak: 0.25, type: 'triangle', delay: 0.13 });
  tone({ freq: base * 1.5, dur: 0.3, peak: 0.3, type: 'triangle', delay: 0.26 });
}
export function playDefuseTick() {
  tone({ freq: 1750, dur: 0.04, peak: 0.18, type: 'square' });
}
export function playScope() {
  noise({ dur: 0.04, freq: 1500, peak: 0.15 });
}

// Harbour ambience: a buoy bell now and then, gulls, water against the lock wall. Started
// once from main.js; very quiet, and it stops caring if the tab is hidden.
let ambienceOn = false;
export function startAmbience(rng) {
  if (!ctx || ambienceOn) return;
  ambienceOn = true;
  const water = ctx.createBufferSource();
  water.buffer = noiseBuf;
  water.loop = true;
  const wf = ctx.createBiquadFilter();
  wf.type = 'lowpass';
  wf.frequency.value = 240;
  const wg = ctx.createGain();
  wg.gain.value = 0.045;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.09;
  const lfoG = ctx.createGain();
  lfoG.gain.value = 0.02;
  lfo.connect(lfoG).connect(wg.gain);
  water.connect(wf).connect(wg).connect(master);
  water.start();
  lfo.start();
  const bell = () => {
    if (!ambienceOn) return;
    tone({ freq: 660, dur: 1.4, peak: 0.05, type: 'sine' });
    tone({ freq: 990, dur: 1.1, peak: 0.02, type: 'sine' });
    setTimeout(bell, 9000 + rng() * 14000);
  };
  setTimeout(bell, 4000);
}

// Drain the state events that carry sounds. Called once per rendered frame by main.js;
// positions are resolved against the player's ears there and passed in as distances.
export function playEvents(events, distOf) {
  for (const e of events) {
    switch (e.kind) {
      case 'shot': playShot(e.weaponKind, e.byPlayer ? 0 : distOf(e)); break;
      case 'dryfire': if (e.byPlayer) playDryFire(); break;
      case 'reload': if (e.byPlayer) playReload(); break;
      case 'hitmark': playHit(e.head); break;
      case 'killconfirm': playKillConfirm(); break;
      case 'hurt': playHurt(); break;
      case 'step': playStep(e.byPlayer ? 0 : distOf(e)); break;
      case 'land': if (e.byPlayer) playJumpLand(); break;
      case 'beep': playBeep(e.fast); break;
      case 'planted': playPlanted(); break;
      case 'explosion': playExplosion(e.byPlayer ? 0 : distOf(e)); break;
      case 'flashpop': playFlashPop(e.byPlayer ? 0 : distOf(e)); break;
      case 'smoke': playSmokeHiss(e.byPlayer ? 0 : distOf(e)); break;
      case 'radio': playRadioBlip(); break;
      case 'buy': playBuy(); break;
      case 'denied': playDenied(); break;
      case 'roundwin': playRoundWin(e.won); break;
      case 'defusetick': playDefuseTick(); break;
      case 'scope': playScope(); break;
      default: break;
    }
  }
}
