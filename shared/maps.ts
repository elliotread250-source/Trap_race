// Base maps as structured data: terrain rectangles in cells, zones, and decoration that never collides.
// Maps may only author barbed wire as a trap. Everything here is permanent and indestructible.
import type { Rect } from './grid';

export type TerrainType = 'solid' | 'ice' | 'oneway';

export interface MapWire { x: number; y: number; rot: 0 | 1 | 2 | 3; len: number } // anchor cell outside the support face

export interface MapDecor { kind: string; x: number; y: number; w?: number; h?: number; layer: number }

export interface MapTheme {
  skyTop: string; skyBottom: string; far: string; mid: string;
  terrain: string; terrainEdge: string; terrainDark: string; accent: string; ice?: string; oneway: string;
}

export interface MapDef {
  id: string;
  name: string;
  blurb: string;
  w: number; // cells
  h: number;
  terrain: { x: number; y: number; w: number; h: number; t: TerrainType }[];
  spawn: Rect; // cells
  finish: Rect; // cells (flag trigger)
  wires: MapWire[];
  decor: MapDecor[];
  theme: MapTheme;
  build: Rect; // cells where players may place
  parTime: string;
}

const border = (w: number, h: number) => [
  { x: 0, y: 0, w, h: 1, t: 'solid' as const },
  { x: 0, y: 0, w: 1, h, t: 'solid' as const },
  { x: w - 1, y: 0, w: 1, h, t: 'solid' as const },
];
const s = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, t: 'solid' as const });
const ice = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, t: 'ice' as const });
const ow = (x: number, y: number, w: number) => ({ x, y, w, h: 1, t: 'oneway' as const });

const rooftop: MapDef = {
  id: 'rooftop',
  name: 'Rooftop Run',
  blurb: 'Run the low roofs, scale the tower or take the fire escape, then sprint home across the skyline.',
  w: 64, h: 26,
  terrain: [
    ...border(64, 26),
    // lower level, heading right
    s(1, 21, 10, 5), // spawn roof
    s(13, 20, 8, 6), s(16, 19, 1, 1), // roof B + chimney
    s(24, 21, 7, 5), s(31, 20, 1, 1), // roof C + vent lip
    s(33, 19, 6, 7), // roof D
    s(42, 21, 7, 5), // roof E
    s(49, 22, 14, 4), // service walkway under the tower
    ow(18, 16, 3), ow(23, 15, 4), ow(29, 15, 3), ow(35, 15, 3), // scaffold shortcut over the pits
    // the climb: tower face (wall jumps) or the fire escape
    s(51, 10, 4, 10), // tower F
    ow(56, 20, 5), ow(58, 18, 5), ow(56, 16, 5), ow(58, 14, 5), ow(56, 12, 5), ow(58, 10, 5),
    // upper level, heading left to the flag
    s(43, 9, 6, 3), // roof H
    s(33, 10, 8, 3), s(36, 9, 1, 1), // roof I + chimney
    s(22, 8, 8, 3), // roof J
    ow(18, 8, 4), // plank bridge
    s(8, 7, 10, 3), // finish roof K
  ],
  spawn: { x: 2, y: 18, w: 4, h: 3 },
  finish: { x: 10, y: 4, w: 3, h: 3 },
  wires: [
    { x: 41, y: 22, rot: 3, len: 3 }, // left face of roof E, down in the pit
    { x: 50, y: 11, rot: 3, len: 3 }, // upper left face of the tower: climb low, then step off
    { x: 30, y: 9, rot: 1, len: 1 }, // right edge of roof J
  ],
  decor: [
    { kind: 'skyline', x: 0, y: 8, w: 64, h: 18, layer: 0 },
    { kind: 'watertower', x: 9, y: 14, layer: 1 }, { kind: 'antenna', x: 36, y: 4, layer: 1 },
    { kind: 'billboard', x: 25, y: 2, layer: 1 }, { kind: 'watertower', x: 46, y: 3, layer: 1 },
  ],
  theme: { skyTop: '#2b2d6e', skyBottom: '#f08a6c', far: '#3b3570', mid: '#54487f', terrain: '#a35a4a', terrainEdge: '#e0a16a', terrainDark: '#5b2f33', accent: '#ffd25e', oneway: '#c99055' },
  build: { x: 1, y: 1, w: 62, h: 25 },
  parTime: '18–25 s',
};

const factory: MapDef = {
  id: 'factory',
  name: 'Factory Shift',
  blurb: 'Zig-zag up the ventilation shaft or climb the grates, then work your way down the catwalks to the dock.',
  w: 64, h: 26,
  terrain: [
    ...border(64, 26),
    s(1, 21, 9, 5), // loading bay (spawn)
    s(12, 22, 8, 4), // floor 2
    ow(13, 18, 4), ow(17, 15, 4), ow(13, 12, 4), ow(17, 9, 4), // service grates (outside route)
    s(12, 6, 3, 1), // top of the grates
    s(23, 21, 9, 5), // shaft floor
    s(25, 6, 1, 13), // shaft left wall (gap at the bottom to walk in)
    s(29, 9, 1, 12), // shaft right wall
    ow(26, 15, 2), // rest ledge inside the shaft
    s(30, 9, 9, 1), // top catwalk
    s(33, 14, 6, 1), // mid catwalk
    s(36, 19, 3, 7), // press base
    s(41, 11, 2, 15), // pillar
    s(43, 14, 5, 1), ow(48, 17, 3), // descent steps
    s(44, 21, 6, 5), // lower floor
    s(52, 20, 11, 6), // dock
    ow(53, 13, 4), s(57, 13, 6, 1), // upper dock gantry
  ],
  spawn: { x: 2, y: 18, w: 4, h: 3 },
  finish: { x: 58, y: 17, w: 3, h: 3 },
  wires: [
    { x: 31, y: 8, rot: 0, len: 3 }, // top of the catwalk exit
    { x: 40, y: 16, rot: 3, len: 3 }, // left face of the pillar
    { x: 36, y: 13, rot: 0, len: 2 }, // mid catwalk
  ],
  decor: [
    { kind: 'pipes', x: 0, y: 2, w: 64, h: 4, layer: 0 },
    { kind: 'gear', x: 8, y: 8, layer: 1 }, { kind: 'press', x: 35, y: 15, layer: 1 },
    { kind: 'gear', x: 47, y: 5, layer: 1 }, { kind: 'smokestack', x: 56, y: 2, layer: 0 },
  ],
  theme: { skyTop: '#1d2530', skyBottom: '#3b4a57', far: '#29343f', mid: '#34424e', terrain: '#6d7782', terrainEdge: '#f2b53a', terrainDark: '#3a4048', accent: '#f2b53a', oneway: '#8d9aa6' },
  build: { x: 1, y: 1, w: 62, h: 25 },
  parTime: '18–26 s',
};

const forest: MapDef = {
  id: 'forest',
  name: 'Forest Heights',
  blurb: 'Climb the giant trunks or the branch ladders, cross the canopy bridges, or brave the forest floor.',
  w: 64, h: 26,
  terrain: [
    ...border(64, 26),
    s(1, 21, 8, 5), // mossy bank (spawn)
    s(11, 22, 11, 4), s(15, 21, 2, 1), // forest floor + rock
    s(22, 10, 3, 16), // great tree A
    ow(18, 19, 4), ow(20, 17, 2), ow(18, 15, 4), ow(20, 13, 2), ow(18, 11, 4), // branch ladder
    ow(25, 10, 8), // canopy bridge 1
    s(33, 7, 2, 12), // tree B
    ow(31, 8, 2), // knot step
    ow(35, 7, 7), // canopy bridge 2
    s(25, 23, 17, 3), s(30, 22, 2, 1), // lower forest floor (alternate route)
    s(42, 9, 2, 17), // tree C
    ow(44, 21, 3), ow(46, 19, 3), ow(44, 17, 3), ow(46, 15, 3), ow(44, 13, 3), ow(46, 11, 3), // vine ladder on C
    ow(44, 9, 4), // canopy bridge 3
    s(48, 8, 15, 2), // high meadow
    s(48, 22, 15, 4), // glade below the meadow
  ],
  spawn: { x: 2, y: 18, w: 4, h: 3 },
  finish: { x: 58, y: 5, w: 3, h: 3 },
  wires: [
    { x: 41, y: 13, rot: 3, len: 3 }, // thorns on the left of tree C
    { x: 21, y: 21, rot: 3, len: 2 }, // thorns at the base of tree A
    { x: 52, y: 7, rot: 0, len: 2 }, // bramble on the meadow
  ],
  decor: [
    { kind: 'hills', x: 0, y: 8, w: 64, h: 18, layer: 0 },
    { kind: 'pine', x: 6, y: 9, layer: 1 }, { kind: 'pine', x: 28, y: 13, layer: 1 }, { kind: 'pine', x: 38, y: 12, layer: 1 },
    { kind: 'pine', x: 53, y: 12, layer: 1 }, { kind: 'moon', x: 47, y: 1, layer: 0 },
  ],
  theme: { skyTop: '#123a3a', skyBottom: '#76b58a', far: '#1e5145', mid: '#2c6b4f', terrain: '#6b4a2e', terrainEdge: '#7ccf5a', terrainDark: '#3c2a1c', accent: '#ffcf6e', oneway: '#a0763f' },
  build: { x: 1, y: 1, w: 62, h: 25 },
  parTime: '18–28 s',
};

const frost: MapDef = {
  id: 'frost',
  name: 'Frostline Ridge',
  blurb: 'Slippery blue ice up the mountain. Cut through the cave or scale the open ridge to the summit.',
  w: 64, h: 26,
  terrain: [
    ...border(64, 26),
    s(1, 21, 9, 5), // base camp (spawn)
    ice(12, 21, 6, 5), // ice shelf (slippery)
    s(18, 19, 4, 7), // ledge
    ice(24, 17, 5, 1), s(22, 21, 14, 5), // icy step + cave floor
    s(24, 18, 12, 2), // cave roof
    s(29, 11, 2, 7), // ridge pillar (climb)
    ow(25, 14, 3), ow(26, 12, 2), // ice-axe rungs
    s(36, 16, 6, 10), // cave exit block
    ice(31, 11, 9, 1), // ridge ice walk
    ow(40, 9, 4), // rope
    s(44, 12, 3, 14), // crag
    ice(42, 20, 2, 1), // cave exit step
    ow(47, 16, 3), ow(49, 13, 3), // ledges
    s(52, 10, 11, 16), // summit
    s(47, 22, 5, 4), // gully floor
  ],
  spawn: { x: 2, y: 18, w: 4, h: 3 },
  finish: { x: 57, y: 7, w: 3, h: 3 },
  wires: [
    { x: 35, y: 17, rot: 3, len: 2 }, // left face of the cave exit block
    { x: 43, y: 13, rot: 3, len: 3 }, // icicles down the crag's left face
    { x: 33, y: 10, rot: 0, len: 2 }, // on the ridge walk
  ],
  decor: [
    { kind: 'peaks', x: 0, y: 4, w: 64, h: 22, layer: 0 },
    { kind: 'flagpole', x: 12, y: 15, layer: 1 }, { kind: 'snowdrift', x: 37, y: 6, layer: 1 }, { kind: 'aurora', x: 0, y: 0, w: 64, h: 4, layer: 0 },
  ],
  theme: { skyTop: '#1b2a4a', skyBottom: '#9cc7e8', far: '#476b90', mid: '#6d93b8', terrain: '#8a96a8', terrainEdge: '#f4fbff', terrainDark: '#4a5468', accent: '#ff6a5e', ice: '#7fd8ff', oneway: '#b0bccb' },
  build: { x: 1, y: 1, w: 62, h: 25 },
  parTime: '18–28 s',
};

/** Test lab: flat floor, a 12-cell wall, a pit. Not offered in the lobby; used by automated tests. */
const lab: MapDef = {
  id: 'lab', name: 'Test Lab', blurb: 'Automated test arena.', w: 40, h: 20,
  terrain: [...border(40, 20), s(1, 16, 38, 4), s(20, 4, 2, 12)],
  spawn: { x: 2, y: 13, w: 3, h: 3 }, finish: { x: 35, y: 13, w: 3, h: 3 }, wires: [], decor: [],
  theme: rooftop.theme, build: { x: 1, y: 1, w: 38, h: 19 }, parTime: '-',
};

export const MAPS: Record<string, MapDef> = { rooftop, factory, forest, frost, lab };
export const MAP_LIST: readonly MapDef[] = [rooftop, factory, forest, frost];
export function getMap(id: string): MapDef { return MAPS[id] ?? rooftop; }
