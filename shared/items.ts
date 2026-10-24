// Data-driven item catalogue. Masks are occupied cells at rotation 0, anchored at the top-left of their bounding box.
import type { Cell } from './grid';
import { HAZARD, MOVERS, NEWITEMS, POWER } from './config';

export type ItemKind =
  | 'block' | 'oneway' | 'spring' | 'conveyor' | 'moving' | 'crumble' | 'shuttle' | 'wheel'
  | 'oval' | 'rspikes' | 'saw' | 'laser' | 'pendulum'
  | 'blackhole' | 'sniper' | 'cannon' | 'crossbow' | 'wire'
  | 'coin' | 'power' | 'bomb'
  | 'planemaker' | 'fan' | 'grave' | 'turret' | 'ice';

export type DraftGroup = 'construction' | 'hazard' | 'utility' | 'demolition';
export type PowerType = 'speed' | 'jump' | 'shield' | 'slow';

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  group: DraftGroup;
  category: string; // label shown on the card
  mask: Cell[];
  rotatable: boolean;
  /** Blocks player movement and projectiles. */
  solid: boolean;
  /** Can hold a tripod sniper or barbed wire. */
  supportive: boolean;
  /** Timing runs at half speed during a slow-trap pulse. */
  slowable: boolean;
  /**
   * Takes up no grid squares for other items: anything may be built over it and it may be built over (most) objects.
   * Overlays only conflict with overlays of their own kind. Saw rails and ice are overlays.
   */
  overlay?: boolean;
  variants?: string[]; // locked facing variants chosen before placement (sniper)
  wireLength?: number;
  bombSize?: number;
  power?: PowerType;
  weight: number;
  desc: string;
  rotationNote: string;
}

const rect = (w: number, h: number): Cell[] => {
  const out: Cell[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push([x, y]);
  return out;
};

const ROT_ALL = 'Rotates in quarter turns.';

const defs: ItemDef[] = [
  // Construction: exact sizes in cells (w x h at rotation 0).
  { id: 'block_1x1', name: 'Block 1×1', kind: 'block', group: 'construction', category: 'Block', mask: rect(1, 1), rotatable: true, solid: true, supportive: true, slowable: false, weight: 1, desc: 'A solid 1×1 block. Stand on it, wall-jump off it, bolt traps to it.', rotationNote: 'Rotates (symmetric).' },
  { id: 'block_1x2', name: 'Block 1×2', kind: 'block', group: 'construction', category: 'Block', mask: rect(1, 2), rotatable: true, solid: true, supportive: true, slowable: false, weight: 1, desc: 'A solid block one cell wide and two tall. Rotate for 2×1.', rotationNote: 'Rotates: 1×2 ↔ 2×1.' },
  { id: 'block_2x2', name: 'Block 2×2', kind: 'block', group: 'construction', category: 'Block', mask: rect(2, 2), rotatable: true, solid: true, supportive: true, slowable: false, weight: 1, desc: 'A solid 2×2 block.', rotationNote: 'Rotates (symmetric).' },
  { id: 'block_2x3', name: 'Block 2×3', kind: 'block', group: 'construction', category: 'Block', mask: rect(2, 3), rotatable: true, solid: true, supportive: true, slowable: false, weight: 0.9, desc: 'A solid block two wide and three tall. Rotate for 3×2.', rotationNote: 'Rotates: 2×3 ↔ 3×2.' },
  { id: 'block_3x3', name: 'Block 3×3', kind: 'block', group: 'construction', category: 'Block', mask: rect(3, 3), rotatable: true, solid: true, supportive: true, slowable: false, weight: 0.7, desc: 'A big solid 3×3 block.', rotationNote: 'Rotates (symmetric).' },
  { id: 'plank_3', name: 'Plank 3', kind: 'block', group: 'construction', category: 'Plank', mask: rect(3, 1), rotatable: true, solid: true, supportive: true, slowable: false, weight: 1.1, desc: 'Solid plank, one cell thick and 3 long. Upright planks are wall-jump surfaces.', rotationNote: 'Rotates: horizontal ↔ upright.' },
  { id: 'plank_5', name: 'Plank 5', kind: 'block', group: 'construction', category: 'Plank', mask: rect(5, 1), rotatable: true, solid: true, supportive: true, slowable: false, weight: 1, desc: 'Solid plank, one cell thick and 5 long.', rotationNote: 'Rotates: horizontal ↔ upright.' },
  { id: 'plank_7', name: 'Plank 7', kind: 'block', group: 'construction', category: 'Plank', mask: rect(7, 1), rotatable: true, solid: true, supportive: true, slowable: false, weight: 0.8, desc: 'Solid plank, one cell thick and 7 long.', rotationNote: 'Rotates: horizontal ↔ upright.' },
  { id: 'l_block', name: 'L Block', kind: 'block', group: 'construction', category: 'Block', mask: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]], rotatable: true, solid: true, supportive: true, slowable: false, weight: 1, desc: 'Five solid cells in an L inside a 3×3 box. The inner corner is genuinely empty.', rotationNote: 'Rotates into all four L orientations.' },
  { id: 'stairs', name: 'Stair Section', kind: 'block', group: 'construction', category: 'Traversal', mask: [[2, 0], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]], rotatable: true, solid: true, supportive: true, slowable: false, weight: 0.8, desc: 'Three solid steps climbing to the right.', rotationNote: ROT_ALL },
  { id: 'oneway', name: 'One-Way Platform', kind: 'oneway', group: 'construction', category: 'Traversal', mask: rect(3, 1), rotatable: true, solid: false, supportive: false, slowable: false, weight: 0.9, desc: 'Solid only from its marked side. Jump up through it; press Down to drop through.', rotationNote: 'Rotates: the solid side turns with it.' },
  { id: 'spring', name: 'Spring Pad', kind: 'spring', group: 'construction', category: 'Traversal', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, weight: 0.9, desc: 'Launches anyone who touches the pad along its surface direction.', rotationNote: 'Rotates: launch direction follows the pad.' },
  { id: 'conveyor', name: 'Conveyor', kind: 'conveyor', group: 'construction', category: 'Traversal', mask: rect(3, 1), rotatable: true, solid: true, supportive: true, slowable: false, weight: 0.7, desc: 'A solid belt. Flat belts carry riders along the arrows; upright belts drag wall-sliders up or down at 130 px/s.', rotationNote: 'Rotates: belt direction turns (right, down, left, up).' },
  { id: 'moving', name: 'Moving Platform', kind: 'moving', group: 'construction', category: 'Traversal', mask: rect(3, 1), rotatable: true, solid: true, supportive: false, slowable: true, weight: 0.8, desc: `Glides ${HAZARD.movingPathCells} cells end to end and carries riders. Walls do not stop it: it slides straight through them. Squeeze someone against a block and they die. Slowed by Slow Pulse.`, rotationNote: 'Rotates: path direction turns with it.' },
  { id: 'shuttle', name: 'Shuttle Block 2×1', kind: 'shuttle', group: 'construction', category: 'Moving', mask: rect(2, 1), rotatable: true, solid: true, supportive: false, slowable: false, weight: 0.9, desc: `A solid 2×1 block that glides ${MOVERS.shuttleTravelCells} cells along the arrow and back every ${MOVERS.shuttlePeriodTicks / 60}s, easing to a stop at each end. Carries riders, passes through walls, and crushes anyone pinned against a block. It may start partly inside a wall, never fully.`, rotationNote: 'Rotates: a quarter turn makes it a 1×2 lift. The arrow shows which way it sets off at GO.' },
  { id: 'wheel', name: 'Ferris Wheel', kind: 'wheel', group: 'construction', category: 'Moving', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, variants: ['Clockwise', 'Counter-clockwise'], weight: 0.7, desc: `Four solid 2×1 gondolas orbit a pivot ${MOVERS.wheelRadiusCells} cells away, one lap every ${MOVERS.wheelPeriodTicks / 60}s. Gondolas stay level and pass through walls and blocks. Place it as long as at least one gondola starts outside walls and blocks. The pivot is not solid and may sit inside a wall.`, rotationNote: 'Rotates: odd turns stand the gondolas upright (1×2). F flips the spin direction.' },
  { id: 'crumble', name: 'Crumbling Platform', kind: 'crumble', group: 'construction', category: 'Traversal', mask: rect(3, 1), rotatable: true, solid: true, supportive: false, slowable: false, weight: 0.7, desc: `Cracks on the first hit and on the second the whole platform falls away, for the rest of the round. A hit is a fresh landing, a fresh wall-slide, or a shot (arrow, cannonball, sniper). Standing still is one hit.`, rotationNote: ROT_ALL },

  { id: 'planemaker', name: 'Paper Plane Maker', kind: 'planemaker', group: 'construction', category: 'Moving', mask: rect(1, 2), rotatable: true, solid: true, supportive: false, slowable: false, variants: ['Fires right', 'Fires left'], weight: 0.8, desc: `A robotic machine that folds and launches a 2×1 paper plane from its top cell every ${NEWITEMS.planeInterval}s, at crossbow-arrow speed. Planes never kill: stand on them and ride. They crumple on hitting players, objects, projectiles or moving bodies, near black holes, or when landed on while flying up. Planes flying down carry you down.`, rotationNote: 'Rotates: fire up, down or sideways. F flips which side it fires to.' },
  { id: 'fan', name: 'Fan 3×1', kind: 'fan', group: 'construction', category: 'Traversal', mask: rect(3, 1), rotatable: true, solid: true, supportive: false, slowable: false, weight: 0.8, desc: `Blows players and projectiles ${NEWITEMS.fanRange} cells out across its 3-cell width, harder the closer they are. Facing up, you settle into steady levitation. Paper planes strafe across its wind and crumple flying into it. Its casing is solid: stand on it, wall-slide and wall-jump on it.`, rotationNote: 'Rotates: the wind turns with it (up by default).' },
  { id: 'ice_3', name: 'Ice 3', kind: 'ice', group: 'construction', category: 'Surface', mask: rect(3, 1), rotatable: false, solid: false, supportive: false, slowable: false, overlay: true, weight: 0.6, desc: 'A slick sheet of ice laid on top of a block, platform or item (moving platforms included). Takes up no grid squares. Walking and sprinting slide: momentum carries.', rotationNote: 'Cannot rotate: always lies on a top surface.' },
  { id: 'ice_5', name: 'Ice 5', kind: 'ice', group: 'construction', category: 'Surface', mask: rect(5, 1), rotatable: false, solid: false, supportive: false, slowable: false, overlay: true, weight: 0.5, desc: 'Five cells of slick ice on top of a block, platform or item. Takes up no grid squares; unsupported cells are trimmed away.', rotationNote: 'Cannot rotate: always lies on a top surface.' },

  // Hazards
  { id: 'grave', name: 'Gravestone', kind: 'grave', group: 'hazard', category: 'Trap', mask: rect(1, 1), rotatable: false, solid: false, supportive: false, slowable: false, weight: 0.7, desc: `A haunted grave on a little dirt pile you can stand on. Touch the stone and a flower breaks: one of its ghosts waits ${NEWITEMS.ghostWait}s, then chases you through walls, slightly slower than walking. It kills you on contact (and anyone in its way). Reach the flag to lose it. One ghost per player per round.`, rotationNote: 'Cannot rotate.' },
  { id: 'dart_turret', name: 'Dart Turret', kind: 'turret', group: 'hazard', category: 'Launcher', mask: rect(1, 1), rotatable: false, solid: true, supportive: false, slowable: false, weight: 0.7, desc: `Aims at the closest player it can see within 6 cells (walls block its view) and fires a fast dart every ${NEWITEMS.turretInterval}s. Darts pierce players and stop at objects. Solid: stand on it and wall-jump off it.`, rotationNote: 'Cannot rotate: it aims by itself.' },
  { id: 'spiky_oval', name: 'Spiky Oval 3×1', kind: 'oval', group: 'hazard', category: 'Trap', mask: rect(3, 1), rotatable: true, solid: false, supportive: false, slowable: false, weight: 1.1, desc: 'An oval covered in spikes, three cells long and one thick. Lethal to touch, owner included. Fixed in place.', rotationNote: 'Rotates: 3×1 ↔ 1×3.' },
  { id: 'rspikes', name: 'Retracting Spikes', kind: 'rspikes', group: 'hazard', category: 'Timed trap', mask: rect(2, 2), rotatable: true, solid: false, supportive: false, slowable: true, weight: 0.9, desc: `A 2×1 solid base block with spikes that rise from its top face: out ${HAZARD.rspikeOut}s, in ${HAZARD.rspikeIn}s, with a visible warning before they rise. Stand on the base while they are in. Slowed by Slow Pulse.`, rotationNote: 'Rotates the whole assembly: the spikes always sit on the outward face of the base (top by default).' },
  { id: 'saw', name: 'Saw Rail', kind: 'saw', group: 'hazard', category: 'Timed trap', mask: rect(4, 1), rotatable: true, solid: false, supportive: false, slowable: true, overlay: true, weight: 0.9, desc: 'A spinning saw runs back and forth along a 4-cell rail and passes straight through blocks and items. The rail takes up no grid squares: build over it, or lay it through other objects. Slowed by Slow Pulse.', rotationNote: 'Rotates: rail turns upright or flat.' },
  { id: 'laser', name: 'Laser Gate', kind: 'laser', group: 'hazard', category: 'Timed trap', mask: rect(1, 1), rotatable: true, solid: true, supportive: false, slowable: true, weight: 0.8, desc: `Beam up to ${HAZARD.laserMaxCells} cells, stopped by solids. On ${HAZARD.laserOn}s, off ${HAZARD.laserOff}s, flickers before firing. Slow Pulse only stretches the off time.`, rotationNote: 'Rotates: beam direction turns.' },
  { id: 'pendulum', name: 'Swinging Axe', kind: 'pendulum', group: 'hazard', category: 'Timed trap', mask: rect(1, 1), rotatable: true, solid: true, supportive: false, slowable: true, weight: 0.8, desc: 'A heavy blade swings from a solid 1×1 pivot block you can stand on and wall-jump off. Only the blade kills. Slowed by Slow Pulse.', rotationNote: 'Rotates: swing hangs from the new side.' },
  { id: 'blackhole', name: 'Black Hole', kind: 'blackhole', group: 'hazard', category: 'Trap', mask: rect(1, 1), rotatable: false, solid: false, supportive: false, slowable: false, weight: 0.8, desc: `Pulls players and projectiles within ${Math.round(HAZARD.holeRadius / 48 * 10) / 10} cells toward its core and kills on contact with the core. Come in with sideways speed to swing around it. Solids block the pull. Not affected by Slow Pulse.`, rotationNote: 'Cannot rotate.' },
  { id: 'sniper', name: 'Tripod Sniper', kind: 'sniper', group: 'hazard', category: 'Launcher', mask: rect(1, 1), rotatable: false, solid: true, supportive: false, slowable: false, variants: ['Faces right', 'Faces left'], weight: 0.8, desc: `Must sit on top of a solid block. Fires every ${HAZARD.sniperInterval}s exactly; shots land instantly, pierce players and stop at blocks. Black holes bend the shot. Not slowed.`, rotationNote: 'Cannot rotate. Choose left or right facing before placing (F).' },
  { id: 'cannon', name: 'Cannon', kind: 'cannon', group: 'hazard', category: 'Launcher', mask: rect(1, 1), rotatable: true, solid: true, supportive: false, slowable: false, weight: 0.8, desc: `Lobs a cannonball on a gravity arc every ${HAZARD.cannonInterval}s. Ball stops at the first player or block. Can float.`, rotationNote: 'Rotates: muzzle direction turns.' },
  { id: 'crossbow', name: 'Crossbow', kind: 'crossbow', group: 'hazard', category: 'Launcher', mask: rect(1, 1), rotatable: true, solid: true, supportive: false, slowable: false, weight: 0.8, desc: `Fires a slow, straight arrow every ${HAZARD.crossbowInterval}s. Arrows break on the first player, shield or not. Black holes bend them. Can float, and its solid mount can be stood on.`, rotationNote: 'Rotates: firing direction turns.' },
  { id: 'wire_1', name: 'Barbed Wire 1', kind: 'wire', group: 'hazard', category: 'Edge trap', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, wireLength: 1, weight: 0.6, desc: 'Bolts to an exposed block edge, or onto a Moving Platform or Shuttle Block and rides with it (through walls too). Lethal strip, even while wall sliding.', rotationNote: 'Rotates: top, right, bottom or left edge.' },
  { id: 'wire_2', name: 'Barbed Wire 2', kind: 'wire', group: 'hazard', category: 'Edge trap', mask: rect(2, 1), rotatable: true, solid: false, supportive: false, slowable: false, wireLength: 2, weight: 0.6, desc: 'Two segments along one block or moving-platform edge. Segments without support are trimmed away.', rotationNote: 'Rotates: top, right, bottom or left edge.' },
  { id: 'wire_3', name: 'Barbed Wire 3', kind: 'wire', group: 'hazard', category: 'Edge trap', mask: rect(3, 1), rotatable: true, solid: false, supportive: false, slowable: false, wireLength: 3, weight: 0.6, desc: 'Three segments along one block edge. On a shorter edge the extra segments are removed.', rotationNote: 'Rotates: top, right, bottom or left edge.' },

  // Utility
  { id: 'coin', name: 'Coin', kind: 'coin', group: 'utility', category: 'Reward', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, weight: 1, desc: 'Grab it and carry it to the flag for +1. Drop it where you die; anyone can pick it up. Once banked it is gone for the rest of the match.', rotationNote: 'Rotates (no gameplay effect).' },
  { id: 'power_speed', name: 'Speed Station', kind: 'power', group: 'utility', category: 'Power-up', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, power: 'speed', weight: 0.6, desc: `First player through gets ${Math.round((POWER.speedMul - 1) * 100)}% more speed for ${POWER.speedDur}s. Refills each race.`, rotationNote: 'Rotates (no gameplay effect).' },
  { id: 'power_jump', name: 'Jump Station', kind: 'power', group: 'utility', category: 'Power-up', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, power: 'jump', weight: 0.6, desc: `First player through jumps higher for ${POWER.jumpDur}s. Refills each race.`, rotationNote: 'Rotates (no gameplay effect).' },
  { id: 'power_shield', name: 'Shield Station', kind: 'power', group: 'utility', category: 'Power-up', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, power: 'shield', weight: 0.6, desc: `Absorbs one lethal trap hit within ${POWER.shieldDur}s. Can't save a fall.`, rotationNote: 'Rotates (no gameplay effect).' },
  { id: 'power_slow', name: 'Slow Pulse Station', kind: 'power', group: 'utility', category: 'Power-up', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, power: 'slow', weight: 0.5, desc: `Halves the speed of timed traps for ${POWER.slowDur}s. Snipers, arrows, cannonballs and black holes are not slowed.`, rotationNote: 'Rotates (no gameplay effect).' },

  // Demolition: square footprint in cells.
  { id: 'bomb_1', name: 'Bomb 1×1', kind: 'bomb', group: 'demolition', category: 'Demolition', mask: rect(1, 1), rotatable: true, solid: false, supportive: false, slowable: false, bombSize: 1, weight: 0.7, desc: 'Removes every player-built object touching this 1×1 area. Map terrain is untouchable.', rotationNote: 'Rotates (area stays 1×1).' },
  { id: 'bomb_2', name: 'Bomb 2×2', kind: 'bomb', group: 'demolition', category: 'Demolition', mask: rect(2, 2), rotatable: true, solid: false, supportive: false, slowable: false, bombSize: 2, weight: 0.7, desc: 'Removes every player-built object touching this 2×2 area, plus anything bolted to them.', rotationNote: 'Rotates (area stays 2×2).' },
  { id: 'bomb_3', name: 'Bomb 3×3', kind: 'bomb', group: 'demolition', category: 'Demolition', mask: rect(3, 3), rotatable: true, solid: false, supportive: false, slowable: false, bombSize: 3, weight: 0.5, desc: 'Removes every player-built object touching this 3×3 area, plus anything bolted to them.', rotationNote: 'Rotates (area stays 3×3).' },
];

export const ITEMS: Record<string, ItemDef> = Object.fromEntries(defs.map(d => [d.id, d]));
export const ITEM_LIST: readonly ItemDef[] = defs;

export function getItem(id: string): ItemDef {
  const d = ITEMS[id];
  if (!d) throw new Error(`unknown item ${id}`);
  return d;
}

/** Kinds that count as stationary solid support for snipers and barbed wire. */
export const SUPPORT_KINDS: ReadonlySet<ItemKind> = new Set(['block', 'conveyor']);
/** Platforms whose solid bodies move on a fixed tick-based path (their swept area is reserved). */
export const KINEMATIC_KINDS: ReadonlySet<ItemKind> = new Set(['shuttle', 'wheel']);
/** Kinds a paper plane flies straight past (everything else it touches crumples it). */
export const PLANE_PASSES: ReadonlySet<ItemKind> = new Set(['coin', 'power', 'ice', 'blackhole']);
export const HAZARD_KINDS: ReadonlySet<ItemKind> = new Set(['oval', 'rspikes', 'saw', 'laser', 'pendulum', 'blackhole', 'sniper', 'cannon', 'crossbow', 'wire', 'grave', 'turret']);

/**
 * Items that no longer exist. A saved world that still holds one is migrated explicitly (see migrateSnapshot):
 * a string is the replacement item id, null means the instance is removed.
 */
export const LEGACY_ITEMS: Record<string, string | null> = { spikes: 'spiky_oval', dart: null };
