// input.js — keyboard and mouse for the human player, written into one intent object
// that player.js consumes. The demo brain writes the same shape, so the simulation never
// cares whose hands are on the controls.

export const intent = {
  fwd: 0, // -1..1 along facing
  strafe: 0, // -1..1, right positive
  sprint: false,
  crouch: false,
  jump: false, // edge-triggered, consumed by player.js
  fire: false,
  aim: false, // right mouse: scope / tighter spread
  reload: false, // edge-triggered
  use: false, // E held: plant / defuse
  usePressed: false,
  slot: 0, // 0 none, 1 primary, 2 secondary — edge-triggered
  throwFrag: false,
  throwSmoke: false,
  throwFlash: false,
  buyKey: null, // edge-triggered buy menu key, consumed by main.js
  scoreboard: false,
};

const keys = new Set();
let yawDelta = 0;
let pitchDelta = 0;
export let locked = false;

export function initInput(canvas, onFirstGesture) {
  canvas.addEventListener('click', () => {
    if (!locked) canvas.requestPointerLock();
    if (onFirstGesture) onFirstGesture();
  });
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
  });
  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    yawDelta += e.movementX;
    pitchDelta += e.movementY;
  });
  document.addEventListener('mousedown', (e) => {
    if (!locked) return;
    if (e.button === 0) intent.fire = true;
    if (e.button === 2) intent.aim = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) intent.fire = false;
    if (e.button === 2) intent.aim = false;
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    switch (e.code) {
      case 'Space': intent.jump = true; e.preventDefault(); break;
      case 'KeyR': intent.reload = true; break;
      case 'KeyE': intent.use = true; intent.usePressed = true; break;
      case 'Digit1': intent.slot = 1; break;
      case 'Digit2': intent.slot = 2; break;
      case 'Digit3': intent.throwFrag = true; break;
      case 'Digit4': intent.throwSmoke = true; break;
      case 'Digit5': intent.throwFlash = true; break;
      case 'KeyB': intent.buyKey = 'B'; break;
      default:
        if (/^Digit[1-9]$/.test(e.code) || /^Numpad[1-9]$/.test(e.code)) intent.buyKey = e.code.replace('Digit', '').replace('Numpad', '');
        break;
    }
    intent.scoreboard = keys.has('Tab');
    if (e.code === 'Tab') e.preventDefault();
  });
  document.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (e.code === 'KeyE') intent.use = false;
    intent.scoreboard = keys.has('Tab');
  });
  const poll = () => {
    intent.fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) + (keys.has('KeyS') || keys.has('ArrowDown') ? -1 : 0);
    intent.strafe = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) + (keys.has('KeyA') || keys.has('ArrowLeft') ? -1 : 0);
    intent.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    intent.crouch = keys.has('ControlLeft') || keys.has('KeyC');
  };
  setInterval(poll, 16);
}

// Mouse look accumulated since the last tick, in pixels; sensitivity lives in player.js.
export function takeLook() {
  const d = { dx: yawDelta, dy: pitchDelta };
  yawDelta = 0;
  pitchDelta = 0;
  return d;
}

// Edge-triggered flags are cleared by their consumers; this clears the rest each tick so
// a stale press cannot leak into the next round.
export function clearEdges() {
  intent.jump = false;
  intent.reload = false;
  intent.usePressed = false;
  intent.slot = 0;
  intent.throwFrag = false;
  intent.throwSmoke = false;
  intent.throwFlash = false;
  intent.buyKey = null;
}
