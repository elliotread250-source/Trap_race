import { CELL, PHYS } from '../../shared/config';
import type { Rot } from '../../shared/grid';
import { checkPlacement, makeObject, applyPlacement } from '../../shared/placement';
import { World } from '../../shared/world';

/** Place an item directly (shape rules only) and return the object. Throws with the reason if illegal. */
export function put(world: World, item: string, x: number, y: number, rot: Rot = 0, owner = 'p1', variant = 0) {
  const req = { item, x, y, rot, variant };
  const c = checkPlacement(world, req);
  if (!c.ok) throw new Error(`${item}@${x},${y}: ${c.reason}`);
  const o = makeObject(world, req, c, owner, 1);
  applyPlacement(world, o);
  return o;
}

/** Lab map: floor top at row 16 spanning x 1..38, wall columns 20-21 rows 4..15. */
export const lab = () => new World('lab');
export const floorY = (row = 16) => row * CELL - PHYS.bodyH;
