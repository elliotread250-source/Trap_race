// Player movement: one deterministic fixed-step function used by the server, client prediction, bots and route probes.
import { CELL, DT, PHYS } from './config';
import { DIRS, type Rect } from './grid';
import { C_ONEWAY, C_SOLID, S_CONVEYOR, S_ICE, type World } from './world';

export const IN_LEFT = 1, IN_RIGHT = 2, IN_JUMP = 4, IN_SPRINT = 8, IN_DOWN = 16;

export interface Body {
  x: number; y: number; // top-left of the 28x42 collision body
  vx: number; vy: number;
  grounded: boolean;
  groundSurf: number; // S_* of the floor
  groundObj: string | null; // object id under the feet (crumble detection)
  groundMover: number; // index of mover stood on, -1 none
  wallDir: number; // -1 left contact, 1 right contact, 0 none
  wallSliding: boolean;
  wallJumpReady: boolean;
  coyote: number;
  jumpBuf: number;
  prevJump: boolean;
  jumpRising: boolean;
  assistT: number;
  assistDir: number;
  lockT: number; // spring control lock
  dropT: number;
  facing: number;
  wallJumped: boolean; // set on the tick a wall jump happened (for effects)
  jumped: boolean;
  landed: boolean;
}

export interface Mover { x: number; y: number; w: number; h: number; dx: number; dy: number }

export interface PhysEnv {
  world: World;
  /** dynamic solid test (crumble state) */
  isSolid(cx: number, cy: number): boolean;
  movers: Mover[];
  /** extra acceleration (black holes); may be null */
  accel?: (b: Body) => { ax: number; ay: number } | null;
  speedMul: number;
  jumpMul: number;
}

export function newBody(x: number, y: number): Body {
  return {
    x, y, vx: 0, vy: 0, grounded: false, groundSurf: 0, groundObj: null, groundMover: -1, wallDir: 0, wallSliding: false,
    wallJumpReady: true, coyote: 0, jumpBuf: 0, prevJump: false, jumpRising: false, assistT: 0, assistDir: 0, lockT: 0, dropT: 0,
    facing: 1, wallJumped: false, jumped: false, landed: false,
  };
}

export function cloneBody(b: Body): Body { return { ...b }; }

export function staticEnv(world: World): PhysEnv {
  return { world, isSolid: (x, y) => world.solidCell(x, y), movers: [], speedMul: 1, jumpMul: 1 };
}

const W = PHYS.bodyW, H = PHYS.bodyH;
const EPS = 0.001;

function overlapsSolid(env: PhysEnv, x: number, y: number): boolean {
  const x0 = Math.floor(x / CELL), x1 = Math.floor((x + W - EPS) / CELL);
  const y0 = Math.floor(y / CELL), y1 = Math.floor((y + H - EPS) / CELL);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (env.isSolid(cx, cy)) return true;
  for (const m of env.movers) if (x < m.x + m.w && x + W > m.x && y < m.y + m.h && y + H > m.y) return true;
  return false;
}

function onewayAt(env: PhysEnv, cx: number, cy: number): number {
  const w = env.world;
  if (!w.inBounds(cx, cy)) return -1;
  const i = w.idx(cx, cy);
  return w.coll[i] === C_ONEWAY ? w.collDir[i] : -1;
}

function moveX(b: Body, env: PhysEnv, dx: number) {
  if (dx === 0) return;
  const prevX = b.x;
  b.x += dx;
  const y0 = Math.floor(b.y / CELL), y1 = Math.floor((b.y + H - EPS) / CELL);
  if (dx > 0) {
    const cx = Math.floor((b.x + W - EPS) / CELL);
    for (let cy = y0; cy <= y1; cy++) {
      const solid = env.isSolid(cx, cy);
      // one-way with normal left (dir 3) blocks entry from the left
      const ow = !solid && onewayAt(env, cx, cy) === 3 && prevX + W <= cx * CELL + EPS;
      if (solid || ow) { b.x = cx * CELL - W; b.vx = Math.min(0, b.vx); break; }
    }
  } else {
    const cx = Math.floor(b.x / CELL);
    for (let cy = y0; cy <= y1; cy++) {
      const solid = env.isSolid(cx, cy);
      const ow = !solid && onewayAt(env, cx, cy) === 1 && prevX >= (cx + 1) * CELL - EPS;
      if (solid || ow) { b.x = (cx + 1) * CELL; b.vx = Math.max(0, b.vx); break; }
    }
  }
  for (const m of env.movers) {
    if (b.y < m.y + m.h && b.y + H > m.y && b.x < m.x + m.w && b.x + W > m.x) {
      if (dx > 0) b.x = m.x - W; else b.x = m.x + m.w;
      b.vx = 0;
    }
  }
}

function moveY(b: Body, env: PhysEnv, dy: number) {
  if (dy === 0) return;
  const prevY = b.y;
  b.y += dy;
  const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + W - EPS) / CELL);
  if (dy > 0) {
    const cy = Math.floor((b.y + H - EPS) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      const solid = env.isSolid(cx, cy);
      const ow = !solid && b.dropT <= 0 && onewayAt(env, cx, cy) === 0 && prevY + H <= cy * CELL + EPS;
      if (solid || ow) { b.y = cy * CELL - H; b.vy = 0; break; }
    }
  } else {
    const cy = Math.floor(b.y / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      const solid = env.isSolid(cx, cy);
      const ow = !solid && onewayAt(env, cx, cy) === 2 && prevY >= (cy + 1) * CELL - EPS;
      if (solid || ow) { b.y = (cy + 1) * CELL; b.vy = 0; b.jumpRising = false; break; }
    }
  }
  for (const m of env.movers) {
    if (b.x < m.x + m.w && b.x + W > m.x && b.y < m.y + m.h && b.y + H > m.y) {
      if (dy > 0) { b.y = m.y - H; b.vy = 0; } else { b.y = m.y + m.h; b.vy = 0; b.jumpRising = false; }
    }
  }
}

/** Probe the floor 1px under the feet. */
function probeGround(b: Body, env: PhysEnv) {
  b.grounded = false; b.groundSurf = 0; b.groundObj = null; b.groundMover = -1;
  const feet = b.y + H;
  const cy = Math.floor((feet + 0.5) / CELL);
  const onLine = Math.abs(feet - cy * CELL) < 0.6;
  if (onLine) {
    const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + W - EPS) / CELL);
    const w = env.world;
    for (let cx = x0; cx <= x1; cx++) {
      const solid = env.isSolid(cx, cy);
      const ow = !solid && b.dropT <= 0 && onewayAt(env, cx, cy) === 0;
      if (solid || ow) {
        b.grounded = true;
        if (w.inBounds(cx, cy)) {
          const i = w.idx(cx, cy);
          if (w.surf[i] === S_ICE && b.groundSurf === 0) b.groundSurf = S_ICE;
          if (w.surf[i] === S_CONVEYOR) b.groundSurf = S_CONVEYOR;
          if (w.collObj[i]) b.groundObj = w.collObj[i];
        }
      }
    }
  }
  for (let i = 0; i < env.movers.length; i++) {
    const m = env.movers[i];
    if (Math.abs(feet - m.y) < 0.6 && b.x < m.x + m.w && b.x + W > m.x) { b.grounded = true; b.groundMover = i; }
  }
}

function probeWall(b: Body, env: PhysEnv): number {
  const y0 = Math.floor((b.y + 2) / CELL), y1 = Math.floor((b.y + H - 2) / CELL);
  let left = false, right = false;
  const rx = b.x + W, lx = b.x;
  if (Math.abs(rx - Math.round(rx / CELL) * CELL) < 0.6) {
    const cx = Math.round(rx / CELL);
    for (let cy = y0; cy <= y1; cy++) if (env.isSolid(cx, cy)) right = true;
  }
  if (Math.abs(lx - Math.round(lx / CELL) * CELL) < 0.6) {
    const cx = Math.round(lx / CELL) - 1;
    for (let cy = y0; cy <= y1; cy++) if (env.isSolid(cx, cy)) left = true;
  }
  for (const m of env.movers) {
    if (b.y + 2 < m.y + m.h && b.y + H - 2 > m.y) {
      if (Math.abs(rx - m.x) < 0.6) right = true;
      if (Math.abs(lx - (m.x + m.w)) < 0.6) left = true;
    }
  }
  if (right && !left) return 1;
  if (left && !right) return -1;
  if (left && right) return b.facing >= 0 ? 1 : -1;
  return 0;
}

/** Conveyor carry along the belt tangent: horizontal belts move riders, vertical belts move wall-sliders. */
function conveyorCarry(b: Body, env: PhysEnv): { dx: number; dy: number } {
  const w = env.world;
  let dx = 0, dy = 0;
  const sp = PHYS.conveyorSpeed * DT;
  if (b.grounded && b.groundSurf === S_CONVEYOR) {
    const cy = Math.round((b.y + H) / CELL);
    const cx = Math.floor((b.x + W / 2) / CELL);
    if (w.inBounds(cx, cy) && w.surf[w.idx(cx, cy)] === S_CONVEYOR) dx = DIRS[w.collDir[w.idx(cx, cy)]].x * sp;
  }
  if (!b.grounded && b.wallDir !== 0) {
    const cx = b.wallDir > 0 ? Math.round((b.x + W) / CELL) : Math.round(b.x / CELL) - 1;
    const cy = Math.floor((b.y + H / 2) / CELL);
    if (w.inBounds(cx, cy)) {
      const i = w.idx(cx, cy);
      if (w.surf[i] === S_CONVEYOR) dy = DIRS[w.collDir[i]].y * sp;
    }
  }
  return { dx, dy };
}

function approach(v: number, target: number, amount: number): number {
  if (v < target) return Math.min(target, v + amount);
  if (v > target) return Math.max(target, v - amount);
  return v;
}

/** Advance one fixed tick. `input` uses the IN_* bit flags. */
export function stepBody(b: Body, input: number, env: PhysEnv): void {
  const dt = DT;
  const left = (input & IN_LEFT) !== 0, right = (input & IN_RIGHT) !== 0;
  const jump = (input & IN_JUMP) !== 0, sprint = (input & IN_SPRINT) !== 0, down = (input & IN_DOWN) !== 0;
  const dir = left === right ? 0 : left ? -1 : 1;
  b.wallJumped = false; b.jumped = false; b.landed = false;
  const wasGrounded = b.grounded;

  if (b.assistT > 0) b.assistT -= dt;
  if (b.lockT > 0) b.lockT -= dt;
  if (b.dropT > 0) b.dropT -= dt;
  if (b.jumpBuf > 0) b.jumpBuf -= dt;
  if (jump && !b.prevJump) b.jumpBuf = PHYS.jumpBuffer;

  // ride a moving platform
  if (b.grounded && b.groundMover >= 0 && env.movers[b.groundMover]) {
    const m = env.movers[b.groundMover];
    const others = env.movers.filter((_, i) => i !== b.groundMover);
    const sub: PhysEnv = { ...env, movers: others };
    moveX(b, sub, m.dx);
    moveY(b, sub, m.dy);
  }

  // horizontal control
  const maxSpeed = (sprint ? PHYS.sprintSpeed : PHYS.walkSpeed) * env.speedMul;
  let accel: number;
  if (b.grounded) {
    accel = dir !== 0 ? PHYS.groundAccel : PHYS.groundDecel;
    if (b.groundSurf === S_ICE) accel *= dir !== 0 ? PHYS.iceAccelMul : PHYS.iceDecelMul;
  } else {
    accel = dir !== 0 ? PHYS.airAccel : PHYS.airDecel;
    if (b.assistT > 0 && dir === b.assistDir) accel *= PHYS.wallJumpAssistMul;
    if (b.lockT > 0) accel *= 0.15;
  }
  const target = dir * maxSpeed;
  if (dir !== 0 && Math.sign(b.vx) === dir && Math.abs(b.vx) > maxSpeed) {
    b.vx = approach(b.vx, target, PHYS.airDecel * dt); // keep spring/boost momentum, bleed it off gently
  } else {
    b.vx = approach(b.vx, target, accel * dt);
  }
  if (dir !== 0) b.facing = dir;

  // gravity and external pull
  b.vy += PHYS.gravity * dt;
  if (env.accel) {
    const a = env.accel(b);
    if (a) { b.vx += a.ax * dt; b.vy += a.ay * dt; }
  }

  // wall slide: airborne, falling, in contact, not steering away
  b.wallSliding = false;
  if (!b.grounded && b.vy > 0 && b.wallDir !== 0 && dir !== -b.wallDir) {
    if (b.vy > PHYS.wallSlideMax) b.vy = PHYS.wallSlideMax;
    b.wallSliding = true;
  }

  // jumping
  if (b.jumpBuf > 0) {
    const onOneway = b.grounded && down && isOnOnewayOnly(b, env);
    if (onOneway) {
      b.dropT = PHYS.dropThroughTime; b.jumpBuf = 0; b.grounded = false; b.y += 1;
    } else if (b.grounded || b.coyote > 0) {
      b.vy = -PHYS.jumpImpulse * env.jumpMul; b.grounded = false; b.coyote = 0; b.jumpBuf = 0; b.jumpRising = true; b.jumped = true;
      b.groundMover = -1;
    } else if (b.wallDir !== 0 && b.wallJumpReady) {
      b.vx = -b.wallDir * PHYS.wallJumpX;
      b.vy = -PHYS.wallJumpY * env.jumpMul;
      b.assistT = PHYS.wallJumpAssist; b.assistDir = b.wallDir;
      b.wallJumpReady = false; b.jumpBuf = 0; b.jumpRising = true; b.wallJumped = true; b.facing = -b.wallDir;
    }
  }
  // variable jump height
  if (b.jumpRising && !jump && b.vy < 0) { b.vy *= PHYS.jumpCutMul; b.jumpRising = false; }
  if (b.vy >= 0) b.jumpRising = false;
  if (b.vy > PHYS.maxFall) b.vy = PHYS.maxFall;
  b.prevJump = jump;

  // integrate with substeps (no tunnelling at any speed we allow)
  const carry = conveyorCarry(b, env);
  const dx = b.vx * dt + carry.dx, dy = b.vy * dt + carry.dy;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / PHYS.maxSubstepPx));
  for (let i = 0; i < steps; i++) { moveX(b, env, dx / steps); moveY(b, env, dy / steps); }

  // resolve being pushed inside a moving platform
  if (env.movers.length && overlapsSolid(env, b.x, b.y)) pushOut(b, env);

  probeGround(b, env);
  if (b.grounded) {
    b.coyote = PHYS.coyoteTime; b.wallJumpReady = true; b.jumpRising = false;
    if (!wasGrounded) b.landed = true;
  } else if (b.coyote > 0) b.coyote -= dt;
  if (b.jumped) b.coyote = 0;
  b.wallDir = b.grounded ? 0 : probeWall(b, env);
  if (b.wallDir === 0) b.wallJumpReady = true; // separation re-arms the wall jump
}

function isOnOnewayOnly(b: Body, env: PhysEnv): boolean {
  const cy = Math.round((b.y + H) / CELL);
  const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + W - EPS) / CELL);
  let ow = false;
  for (let cx = x0; cx <= x1; cx++) {
    if (env.isSolid(cx, cy)) return false;
    if (onewayAt(env, cx, cy) === 0) ow = true;
  }
  return ow && b.groundMover < 0;
}

function pushOut(b: Body, env: PhysEnv) {
  for (let r = 1; r <= 24; r++) {
    for (const [ox, oy] of [[0, -r], [r, 0], [-r, 0], [0, r]]) {
      if (!overlapsSolid(env, b.x + ox, b.y + oy)) { b.x += ox; b.y += oy; return; }
    }
  }
}

export function bodyRect(b: Body): Rect { return { x: b.x, y: b.y, w: W, h: H }; }
export function bodyCenter(b: Body) { return { x: b.x + W / 2, y: b.y + H / 2 }; }
export { overlapsSolid };
