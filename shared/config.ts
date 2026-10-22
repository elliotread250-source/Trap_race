// Every tuning value in one place. Sizes for building are in grid cells; physics is in pixels.

export const GAME_TITLE = 'Trap Race';
export const PROTOCOL_VERSION = 3;

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
  resultsMs: 9000,
  matchResultsMs: 0, // waits for rematch / lobby
  botDraftDelayMs: [2200, 6500] as [number, number],
  botBuildDelayMs: [4500, 14000] as [number, number],
  reconnectGraceMs: 20000,
  lobbyDisconnectRemoveMs: 30000,
  emptyRoomExpireMs: 60000,
  idleLobbyExpireMs: 30 * 60000,
};

export const MATCH = {
  defaultRounds: 8,
  minRounds: 3,
  maxRounds: 12,
  minPlayers: 2,
  maxPlayers: 6,
  maxPlacedObjects: 72, // 8 rounds x 6 players = 48, with headroom; never deletes to make room
  maxProjectiles: 160,
  minPool: 5,
  maxPool: 10,
};

export const SCORING = {
  finish: 1,
  firstFinisher: 1,
  soleFinisher: 1,
  trapElim: 1,
  trapCapPerRound: 3,
  coin: 1,
  attributionWindowS: 3,
};

export const HAZARD = {
  sniperInterval: 2.5,
  sniperWarn: 0.45,
  sniperSpeed: 1500,
  cannonInterval: 3.0,
  cannonMuzzleSpeed: 560,
  cannonGravity: 820,
  cannonBallR: 12,
  crossbowInterval: 2.0,
  arrowSpeed: 620,
  dartInterval: 3.0,
  dartSpeed: 420,
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
  holeRadius: 210,
  holeCore: 15,
  holeMaxPull: 1650,
  holeMaxTotal: 2400,
  holeMaxAffectedSpeed: 640,
  crumbleDelay: 0.45,
  crumbleRespawn: 2.6,
  movingSpeed: 96,
  movingPathCells: 4,
  wireThickness: 11,
  spikeHeight: 20,
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

export const PROTECT_PAD_CELLS = 2; // ~3 character widths around start and finish

export const NET = {
  maxPayloadBytes: 8192,
  msgPerSecond: 140,
  msgBurst: 240,
  inputQueueMax: 12,
};
