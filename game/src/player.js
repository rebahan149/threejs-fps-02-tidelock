// player.js — character movement, shared by the human and every bot: acceleration and
// friction on the ground, slower and quieter while walking or crouched, a jump with real
// gravity, and collision that slides along the map's boxes. Standing still is what makes
// the guns accurate, and this is where that bargain is kept.

import { G, RADIUS, emit } from './state.js';
import { slideMove } from './world.js';

export const SPEED_RUN = 4.6;
export const SPEED_WALK = 2.4;
export const SPEED_CROUCH = 1.7;
const ACCEL = 42;
const FRICTION = 10;
const GRAVITY = 15.5;
const JUMP_VEL = 4.9;

// wish: { fx, fz } desired world-space direction (not necessarily normalised),
// slow: walk key, crouch: bool, jump: bool (edge).
export function stepMovement(a, wish, dt) {
  const blind = (a.blindUntil ?? 0) > G.time;
  const maxSpeed = a.crouch ? SPEED_CROUCH : wish.slow ? SPEED_WALK : SPEED_RUN;
  let wx = wish.fx, wz = wish.fz;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }
  if (blind) { wx *= 0.4; wz *= 0.4; }

  // Friction first, then accelerate toward the wish velocity — the classic source feel:
  // a sharp stop when the keys come off, a slight drift when strafing.
  const fr = Math.max(0, 1 - FRICTION * dt);
  a.vx *= fr;
  a.vz *= fr;
  a.vx += wx * ACCEL * dt;
  a.vz += wz * ACCEL * dt;
  const sp = Math.hypot(a.vx, a.vz);
  if (sp > maxSpeed) {
    a.vx = (a.vx / sp) * maxSpeed;
    a.vz = (a.vz / sp) * maxSpeed;
  }
  a.speedNow = Math.hypot(a.vx, a.vz);

  const beforeX = a.x, beforeZ = a.z;
  slideMove(a, a.vx * dt, a.vz * dt, RADIUS);
  // If a wall ate the motion, kill the velocity into it so actors don't grind.
  if (Math.abs(a.x - beforeX) < Math.abs(a.vx * dt) * 0.4) a.vx = 0;
  if (Math.abs(a.z - beforeZ) < Math.abs(a.vz * dt) * 0.4) a.vz = 0;

  // Vertical: jump and gravity, ground at y=0 everywhere on the apron.
  if (wish.jump && a.onGround) {
    a.vy = JUMP_VEL;
    a.onGround = false;
  }
  if (!a.onGround) {
    a.vy -= GRAVITY * dt;
    a.y += a.vy * dt;
    if (a.y <= 0) {
      a.y = 0;
      a.vy = 0;
      a.onGround = true;
      emit('land', { byPlayer: a.isPlayer, x: a.x, z: a.z });
    }
  }

  // Footsteps: running is loud, walking and crouching are not.
  if (a.onGround && a.speedNow > 0.6) {
    a.stepAt -= dt * a.speedNow;
    if (a.stepAt <= 0) {
      a.stepAt = 2.1;
      const loud = !wish.slow && !a.crouch;
      emit('step', { byPlayer: a.isPlayer, x: a.x, z: a.z });
      if (loud) G.noises.push({ x: a.x, z: a.z, r: 9.5, team: a.team, kind: 'step', at: G.time });
    }
  }
}
