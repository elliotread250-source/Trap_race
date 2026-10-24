// Every tuning value in one place. Sizes for building are in grid cells; physics is in pixels.

export const GAME_TITLE = 'Trap Race';
export const PROTOCOL_VERSION = 6;
/** Version of the item catalogue and stored world data. Older snapshots are migrated (see migrateSnapshot in world.ts). */
export const CONTENT_VERSION = 3;

export const CELL = 48; // pixels per grid cell; one authoritative grid for every map
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const SNAPSHOT_EVERY_TICKS = 3; // 20 Hz snapshots

export const PHYS = {
  bodyW: 28,
  bodyH: 42,
  walkSpeed: 220,
  sprintSpeed: 340,
  groundAccel: 2600,
  groundDecel: 3200,
  airAccel: 1900,
  airDecel: 700,
  gravity: 1400,
  jumpImpulse: 540,
  jumpCutMul: 0.45, // releasing jump while rising keeps 45% of upward speed (variable height)
  maxFall: 950,
  coyoteTime: 0.1,
  jumpBuffer: 0.1,
  wallSlideMax: 90,
  wallJumpX: 260,
  wallJumpY: 520,
  wallJumpAssist: 0.1, // seconds where steering back toward the wall is damped
  wallJumpAssistMul: 0.35,
  iceAccelMul: 0.22,
  iceDecelMul: 0.06,
  springSpeed: 960,
  springSideSpeed: 700,
  springSideLift: 380,
  springControlLock: 0.22,
  conveyorSpeed: 130,
  dropThroughTime: 0.25,
  maxSubstepPx: 10,
};

export const TIMERS = {
  draftMs: 20000,
  buildMs: 35000,
  countdownMs: 3000,
  raceMs: 90000,
  scoutS: 45, // race length while a build-required course has no full route yet
  resultsMs: 9000,
  matchResultsMs: 0, // waits for rematch / lobby
  /** Bots only start choosing after every human has chosen (or timed out); these are their short, staggered think times then. */
  botDraftDelayMs: [400, 1600] as [number, number],
  /** Longest the AI phase of the draft may last once the humans are done. */
  aiDraftMs: 3500,
  botBuildDelayMs: [4500, 14000] as [number, number],
  reconnectGraceMs: 20000,
  lobbyDisconnectRemoveMs: 30000,
  emptyRoomExpireMs: 60000,
  idleLobbyExpireMs: 30 * 60000,
};

export const MATCH = {
  /** host-chosen "score to win", in whole points (inclusive range) */
  defaultTarget: 10,
  minTarget: 5,
  maxTarget: 15,
  /** optional round limit (0 = off). Points to win and the round limit can each be off, never both. */
  defaultRounds: 10,
  minRounds: 3,
  maxRounds: 30,
  minPlayers: 2,
  maxPlayers: 6,
  maxPlacedObjects: 120, // score-target matches have no round limit; the cap only stops runaway growth and never deletes to make room
  maxProjectiles: 160,
  minPool: 5,
  maxPool: 10,
};

/**
 * Scores are integer tenths of a point (0.2 = 2) so totals never pick up floating-point artefacts. Use fmtPts() to show them.
 * finish and coin are the values from before the 0.2 / 0.4 / 0.6 update and are deliberately unchanged.
 */
export const SCORING = {
  unit: 10, // tenths per whole point
  finish: 10,
  firstFinisher: 4,
  soleFinisher: 6,
  trapElim: 2,
  trapCapElimsPerRound: 3, // credited eliminations per round (was 3 points at 1 point each; still 3 eliminations)
  coin: 10, // 1 point per banked coin
  /** extra point for reaching the flag after missing it for comebackAfter or more rounds in a row */
  comeback: 10,
  comebackAfter: 4,
  attributionWindowS: 3,
};

/** 12 -> "12", 2 -> "0.2", 14 -> "1.4". */
export function fmtPts(tenths: number): string {
  const sign = tenths < 0 ? '-' : '';
  const n = Math.abs(Math.round(tenths));
  return n % 10 === 0 ? `${sign}${n / 10}` : `${sign}${Math.floor(n / 10)}.${n % 10}`;
}

export const HAZARD = {
  sniperInterval: 2.5,
  sniperWarn: 0.12, // short, quiet pre-fire glint (was 0.45 s of a bright beam); tunable, the firing interval is unchanged
  /** Sniper shots resolve instantly. Inside a black-hole field the bend model treats the shot as a body of this virtual speed (px/s) so the path curves as a 1500 px/s round would. */
  sniperBendSpeed: 1500,
  sniperStepPx: 8, // march length used only while a shot is inside a gravity field
  sniperMaxPathPx: 7000, // total evaluated path length (a map is at most ~5500 px wide), so a bent shot can never loop forever
  sniperTracerS: 0.12,
  cannonInterval: 3.0,
  cannonMuzzleSpeed: 560,
  cannonGravity: 820,
  cannonBallR: 12,
  crossbowInterval: 1.0, // exactly one shot per second (was 2.0)
  arrowSpeed: 207, // about one third of the previous 620 px/s
  projectileLifetime: 8,
  rspikeOut: 1.4,
  rspikeIn: 1.6,
  rspikeWarn: 0.4,
  laserOn: 1.2,
  laserOff: 1.8,
  laserWarn: 0.5,
  laserMaxCells: 8,
  sawPeriod: 3.2,
  sawR: 21,
  pendulumPeriod: 2.6,
  pendulumArm: 118,
  pendulumBallR: 19,
  pendulumSwingDeg: 68,
  // Black hole (was radius 210, pull 1650 falling linearly to 0 at the edge, total cap 2400, no pull above 640 px/s inward)
  holeRadius: 300, // visible attraction field; the lethal core stays small
  holeCore: 15,
  holeSoft: 36, // softening length: acceleration stops growing as the centre is approached, so there is no singularity
  holePull: 3200, // acceleration at the softened centre of the field (px/s^2), before falloff
  holeFalloff: 1.6, // exponent of the fade towards the field edge
  holeMaxPull: 3200, // per-hole cap
  holeMaxTotal: 4200, // cap on the summed pull of several holes
  holeMaxSpeed: 780, // speed limit while inside a field, so stronger pull can never tunnel through walls or skip the core
  holeProjectileMul: 1, // projectiles feel the same field as players; tune separately if needed
  movingSpeed: 96,
  movingPathCells: 6, // endpoint-to-endpoint travel of the 3x1 Moving Platform: 4 cells before, exactly +2 now
  crumbleHits: 2, // interactions before a crumbling platform breaks for the rest of the round
  crumbleDebounceTicks: 6, // a contact that resumes within this gap is the same interaction
  wireThickness: 11,
  spikeHeight: 20,
};

/** Batch-update items: Paper Plane Maker, Fan, Gravestone, Dart Turret (ice uses PHYS.ice*). */
export const NEWITEMS = {
  planeInterval: 1.4, // one plane every 1.4 s
  planeSpeed: 207, // same as crossbow arrows (HAZARD.arrowSpeed)
  planeLen: 96, // a 2x1 plane: two cells long along its travel...
  planeThick: 24, // ...and half a cell thick (solid, standable)
  planeSlots: 24, // planes alive at once per maker (a plane crossing a 116-cell map takes ~27 s)
  planeHoleCrumple: 216, // within 4.5 cells of a black hole a plane crumples and is sucked in
  planeStrafe: 150, // sideways speed a fan gives a plane flying across its wind (px/s)
  planeHeadwindCells: 3, // flying straight into a fan's wind, a plane crumples within this many cells of it
  fanRange: 5, // cells of wind out from the fan, across its 3-cell width
  fanPushUp: 3000, // acceleration at the fan face for an upward fan (px/s^2): balances gravity ~2.7 cells up
  fanPush: 1700, // at the face for sideways and downward fans
  fanDamp: 4, // velocity damping along the wind inside the column, so a player settles into steady levitation
  fanProjectileMul: 0.6, // projectiles feel this share of the wind
  ghostWait: 1, // seconds a ghost waits at its grave before chasing
  ghostSpeed: 198, // slightly slower than walking (PHYS.walkSpeed 220)
  ghostR: 15,
  turretRange: 288, // 6 cells of vision, blocked by walls
  turretInterval: 2.0, // slightly faster than the sniper's 2.5 s
  dartSpeed: 520, // faster than arrows (207), slower than sniper rounds (1500)
  dartR: 3,
  dirtH: 8, // the gravestone's dirt pile platform
};

/**
 * Kinematic platforms (Shuttle Block, Ferris Wheel). Motion is a pure function of race ticks since GO, so the server,
 * client prediction, rendering and bots all agree. Periods are whole ticks so the motion repeats exactly.
 */
export const MOVERS = {
  shuttleTravelCells: 9, // the 2x1 block slides 9 cells past its anchor and back (was 6, before that 3)
  shuttlePeriodTicks: 576, // 9.6 s round trip (was 6.4 s for 6 cells): the cosine-eased peak stays ~141 px/s
  wheelRadiusCells: 3, // platform centres sit 144 px from the pivot: adjacent gondolas never touch, riders keep headroom
  wheelPeriodTicks: 480, // one lap every 8 s (tangential speed ~113 px/s, slower than walking)
  inheritVelocity: 0, // jumping off a moving platform keeps no platform velocity (bounded at 0 px/s)
  resolveMaxPx: 120, // furthest a moving platform may shove a player out of its way when it catches them
  crushTolPx: 0.01, // overlap below this is float noise, not a squeeze
};

export const POWER = {
  speedMul: 1.3,
  jumpMul: 1.22,
  speedDur: 4,
  jumpDur: 4,
  shieldDur: 5,
  shieldImmunity: 0.9,
  slowDur: 3,
  slowFactor: 0.5,
  maxStackDur: 8,
};

export type Difficulty = 'easy' | 'medium' | 'hard';

/** Bot tuning. Reaction is seconds before acting on a new plan, safety is the chance a bot checks timed hazards before jumping. */
export const BOT_DIFFICULTY: Record<Difficulty, {
  reaction: number; safetyCheck: number; mistakePerSec: number; routeNoise: number; alignTol: number;
  coinGreed: number; riskTolerance: number; hazardPlacement: number;
}> = {
  easy: { reaction: 0.45, safetyCheck: 0.45, mistakePerSec: 0.05, routeNoise: 0.6, alignTol: 3, coinGreed: 0.2, riskTolerance: 0.6, hazardPlacement: 0.4 },
  medium: { reaction: 0.22, safetyCheck: 0.9, mistakePerSec: 0.01, routeNoise: 0.25, alignTol: 2, coinGreed: 0.5, riskTolerance: 0.3, hazardPlacement: 0.65 },
  hard: { reaction: 0.1, safetyCheck: 1, mistakePerSec: 0, routeNoise: 0.05, alignTol: 1.5, coinGreed: 0.8, riskTolerance: 0.15, hazardPlacement: 0.85 },
};

/** Cosmetic emotes. Index is what goes over the network; keys 1-9 and 0 trigger them in that order. */
export const EMOTES = [
  { id: 'wave', name: 'Wave', bubble: 'Hi!' },
  { id: 'dance', name: 'Dance', bubble: '♪♫' },
  { id: 'spin', name: 'Spin', bubble: 'Wheee!' },
  { id: 'flex', name: 'Flex', bubble: 'Strong!' },
  { id: 'laugh', name: 'Laugh', bubble: 'HA HA' },
  { id: 'cry', name: 'Cry', bubble: 'Noooo' },
  { id: 'point', name: 'Point', bubble: 'You!' },
  { id: 'heart', name: 'Heart', bubble: '♥' },
  { id: 'thumbs', name: 'Thumbs up', bubble: 'Nice!' },
  { id: 'floss', name: 'Floss', bubble: '♪' },
] as const;
export const EMOTE = { durationS: 2.6, cooldownMs: 900 };

/** Number of character skins (client art in art.ts SKINS must have exactly this many). */
export const SKIN_COUNT = 16;

export const PROTECT_PAD_CELLS = 2; // ~3 character widths around start and finish

export const NET = {
  maxPayloadBytes: 8192,
  msgPerSecond: 140,
  msgBurst: 240,
  inputQueueMax: 12,
};
