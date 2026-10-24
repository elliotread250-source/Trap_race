// Base maps as structured data: terrain rectangles in cells, zones, and decoration that never collides.
// Maps may only author barbed wire as a trap. Everything here is permanent and indestructible.
import type { Rect } from './grid';
import type { MapFx } from './mapfx';

export type TerrainType = 'solid' | 'ice' | 'oneway';

export interface MapWire { x: number; y: number; rot: 0 | 1 | 2 | 3; len: number } // anchor cell outside the support face

export interface MapDecor { kind: string; x: number; y: number; w?: number; h?: number; layer: number }

export interface MapTheme {
  skyTop: string; skyBottom: string; far: string; mid: string;
  terrain: string; terrainEdge: string; terrainDark: string; accent: string; ice?: string; oneway: string;
  /** richer layered palettes for the large maps: extra parallax layer, atmospheric haze, highlight and accent hues */
  far2?: string; haze?: string; light?: string; accent2?: string; accent3?: string;
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
  /**
   * Ordered progress zones (cells) along the course. While no full route exists yet, a placement may not reduce the
   * furthest zone (then the closest approach to the flag) that players can reach: partial bridges are fine, cutting
   * off progress is not.
   */
  stages?: Rect[];
  /** The course is designed to need player construction before anyone can finish (draft guarantees building cards). */
  buildRequired?: boolean;
  /** Race timer in seconds when longer than the default (measured from bot and route timings on the larger maps). */
  raceS?: number;
  /** Shown in the lobby next to the map name. */
  size?: 'standard' | 'large';
  /** Purely visual material zones (leaves, bark, crystal...) for the renderer; collision is always the terrain grid. */
  materials?: { x: number; y: number; w: number; h: number; m: string }[];
  /** map mechanics: liquid, tsunami, geysers, low gravity, gusts, floating ball (see mapfx.ts) */
  fx?: MapFx;
}

const border = (w: number, h: number) => [
  { x: 0, y: 0, w, h: 1, t: 'solid' as const },
  { x: 0, y: 0, w: 1, h, t: 'solid' as const },
  { x: w - 1, y: 0, w: 1, h, t: 'solid' as const },
];
const s = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, t: 'solid' as const });
const ice = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, t: 'ice' as const });
const ow = (x: number, y: number, w: number) => ({ x, y, w, h: 1, t: 'oneway' as const });

/**
 * Cell painter for organic shapes (a canopy, a mountain with a cave carved out of it). Paint and clear cells, then emit
 * the result as row-run terrain rectangles, the same data format as every other map.
 */
function paint(w: number, h: number, draw: (g: { solid: (x: number, y: number, w: number, h: number) => void; clear: (x: number, y: number, w: number, h: number) => void; oneway: (x: number, y: number, w: number) => void; ice: (x: number, y: number, w: number, h: number) => void; blob: (cx: number, cy: number, rx: number, ry: number) => void; carve: (cx: number, cy: number, rx: number, ry: number) => void }) => void) {
  const g = new Uint8Array(w * h); // 0 empty, 1 solid, 2 ice, 3 oneway
  const set = (x: number, y: number, v: number) => { if (x >= 0 && y >= 0 && x < w && y < h) g[y * w + x] = v; };
  const fill = (x0: number, y0: number, ww: number, hh: number, v: number) => { for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + ww; x++) set(x, y, v); };
  const ell = (cx: number, cy: number, rx: number, ry: number, v: number) => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) set(x, y, v);
    }
  };
  draw({
    solid: (x, y, ww, hh) => fill(x, y, ww, hh, 1), clear: (x, y, ww, hh) => fill(x, y, ww, hh, 0), oneway: (x, y, ww) => fill(x, y, ww, 1, 3),
    ice: (x, y, ww, hh) => fill(x, y, ww, hh, 2), blob: (cx, cy, rx, ry) => ell(cx, cy, rx, ry, 1), carve: (cx, cy, rx, ry) => ell(cx, cy, rx, ry, 0),
  });
  // border last so nothing can carve a seam into the frame
  fill(0, 0, w, 1, 1); fill(0, 0, 1, h, 1); fill(w - 1, 0, 1, h, 1);
  const out: MapDef['terrain'] = [];
  const types: TerrainType[] = ['solid', 'solid', 'ice', 'oneway'];
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const v = g[y * w + x];
      if (!v) { x++; continue; }
      let e = x;
      while (e < w && g[y * w + e] === v) e++;
      out.push({ x, y, w: e - x, h: 1, t: types[v] });
      x = e;
    }
  }
  return out;
}

// Rooftop Run (rebuilt). The old layout looped back over the start: the flag sat 14 cells above spawn and one upright
// plank beside the left wall turned the course into a 5 s shaft climb. Now it runs left to right: low roofs, the tower
// climb, then the high skyline to a flag at the far right. Everything under the high roofs is solid building down to
// the street, so there is no lower path to climb out of next to the finish.
const rooftop: MapDef = {
  id: 'rooftop',
  name: 'Rooftop Run',
  blurb: 'Hop the low roofs east, scale the clock tower or its fire escape, then sprint the high skyline to the flag.',
  w: 72, h: 28,
  terrain: [
    ...border(72, 28),
    // low roofs, heading right
    s(1, 23, 11, 5), // spawn roof
    s(14, 22, 8, 6), s(17, 21, 1, 1), // roof B + chimney
    s(25, 23, 7, 5), s(31, 22, 1, 1), // roof C + vent lip
    s(35, 21, 6, 7), // roof D
    ow(19, 18, 3), ow(24, 17, 4), ow(30, 17, 3), ow(36, 16, 3), // scaffold over the alleys (optional high line)
    s(44, 23, 7, 5), // roof E at the foot of the tower
    // the climb: the clock tower face (wall jumps) or the fire escape bolted to its left
    s(51, 10, 4, 18), // tower, solid down to the street
    ow(45, 21, 4), ow(47, 19, 3), ow(45, 17, 3), ow(47, 15, 3), ow(45, 13, 3), ow(47, 11, 3), // fire escape landings, 2 rows apart
    // the high skyline: every building is solid to the street
    s(57, 12, 5, 16), s(59, 11, 1, 1), // roof F + vent
    s(64, 10, 7, 18), // finish roof G (meets the right wall)
  ],
  spawn: { x: 2, y: 20, w: 4, h: 3 },
  finish: { x: 66, y: 7, w: 3, h: 3 },
  wires: [
    { x: 43, y: 24, rot: 3, len: 3 }, // left face of roof E, down in the alley
    { x: 50, y: 14, rot: 3, len: 3 }, // upper left face of the tower: climb low, then use the fire escape
    { x: 63, y: 14, rot: 3, len: 2 }, // left face of the finish roof, below the jump line
  ],
  decor: [
    { kind: 'skyline', x: 0, y: 8, w: 72, h: 20, layer: 0 },
    { kind: 'watertower', x: 9, y: 16, layer: 1 }, { kind: 'antenna', x: 38, y: 6, layer: 1 },
    { kind: 'billboard', x: 26, y: 4, layer: 1 }, { kind: 'watertower', x: 58, y: 5, layer: 1 },
  ],
  theme: { skyTop: '#2b2d6e', skyBottom: '#f08a6c', far: '#3b3570', mid: '#54487f', terrain: '#a35a4a', terrainEdge: '#e0a16a', terrainDark: '#5b2f33', accent: '#ffd25e', oneway: '#c99055' },
  build: { x: 1, y: 1, w: 70, h: 27 },
  parTime: '16–24 s',
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


// The Great Oak. Linear left to right: meadow, bramble hollow, the oak, the glade and creek, the sunlit hill.
// The oak is solid from canopy top (row 10) to the bottom of the map, so the only way on is over it. Its canopy
// overhangs the trunk on both sides: climbing the trunk ends under the leaves, and the canopy's outer face starts eight
// rows above the left branch, out of reach of jumps and wall climbs. Building on the branch tip bridges that gap: one
// upright Plank 5 or 7, a Spring Pad or a Shuttle lift is enough; shorter pieces need two.
const oak: MapDef = {
  id: 'oak',
  name: 'The Great Oak',
  blurb: 'Cross the meadow and the bramble hollow, build your way over the giant oak, then race the glade to the sunlit hill.',
  w: 112, h: 40, size: 'large', buildRequired: true, raceS: 120,
  terrain: paint(112, 40, g => {
    g.solid(1, 32, 17, 8); g.solid(8, 31, 5, 1); // meadow and a grassy hump (spawn side)
    g.solid(21, 33, 13, 7); g.solid(24, 32, 2, 1); // bramble hollow, a step down past the creek; thorny stump
    g.oneway(27, 29, 4); // fallen log: optional high line
    g.solid(29, 31, 4, 9); g.solid(32, 29, 3, 11); g.solid(34, 27, 3, 1); // root steps, two rows apart
    g.solid(37, 25, 14, 1); // the great left branch, reaching past the canopy edge
    g.solid(44, 33, 7, 7); // root flare
    g.solid(51, 19, 8, 21); // trunk, down to the bottom of the map
    g.solid(47, 10, 16, 1); g.solid(44, 11, 22, 1); g.solid(41, 12, 28, 6); g.solid(43, 18, 24, 1); // canopy dome, overhanging
    g.solid(59, 22, 13, 1); // right branch, under the canopy's far edge
    g.solid(59, 33, 6, 7); g.solid(72, 27, 4, 13); g.solid(76, 30, 4, 10); // root flare and root steps down the far side
    g.solid(80, 32, 4, 8); g.oneway(81, 28, 3); // glade floor, mushroom cap
    g.oneway(86, 30, 3); // floating log in the creek
    g.solid(91, 32, 5, 8); g.oneway(93, 27, 3); // far bank, mushroom cap
    g.solid(96, 30, 5, 10); g.solid(101, 28, 4, 12); g.solid(105, 26, 6, 14); // the sunlit hill
  }),
  spawn: { x: 2, y: 29, w: 4, h: 3 },
  finish: { x: 106, y: 23, w: 3, h: 3 },
  wires: [
    { x: 24, y: 31, rot: 0, len: 2 }, // thorns on the stump
    { x: 50, y: 22, rot: 3, len: 3 }, // thorns on the trunk under the canopy (no lingering in the corner)
    { x: 94, y: 31, rot: 0, len: 1 }, // bramble on the far bank
  ],
  decor: [
    { kind: 'sunrays', x: 30, y: 0, w: 60, h: 30, layer: 0 }, { kind: 'lake', x: 18, y: 34, w: 3, h: 6, layer: 1 }, { kind: 'lake', x: 84, y: 33, w: 7, h: 7, layer: 1 },
    { kind: 'flowers', x: 2, y: 32, w: 15, layer: 1 }, { kind: 'flowers', x: 96, y: 30, w: 14, layer: 1 },
    { kind: 'fern', x: 14, y: 32, layer: 1 }, { kind: 'fern', x: 33, y: 29, layer: 1 }, { kind: 'fern', x: 78, y: 30, layer: 1 },
    { kind: 'mushroom', x: 46, y: 33, layer: 1 }, { kind: 'mushroom', x: 61, y: 33, layer: 1 }, { kind: 'mushroom', x: 82, y: 32, layer: 1 },
    { kind: 'leaves', x: 40, y: 8, w: 32, h: 26, layer: 2 }, { kind: 'butterflies', x: 4, y: 24, w: 30, h: 8, layer: 2 },
    { kind: 'butterflies', x: 84, y: 22, w: 24, h: 8, layer: 2 }, { kind: 'birds', x: 0, y: 2, w: 112, h: 6, layer: 0 },
  ],
  materials: [
    { x: 41, y: 10, w: 28, h: 9, m: 'leaf' }, { x: 51, y: 19, w: 8, h: 21, m: 'bark' }, { x: 37, y: 25, w: 14, h: 1, m: 'branch' },
    { x: 59, y: 22, w: 13, h: 1, m: 'branch' }, { x: 44, y: 33, w: 7, h: 7, m: 'root' }, { x: 59, y: 33, w: 6, h: 7, m: 'root' },
  ],
  theme: {
    skyTop: '#3fa7e6', skyBottom: '#d8f5d0', far: '#6fae9f', far2: '#93c9b4', mid: '#3f8a5c', terrain: '#7a5233', terrainEdge: '#69c94a', terrainDark: '#3e2a1a',
    accent: '#ffd96a', accent2: '#2f8f4e', accent3: '#a7e34f', light: '#fff4c4', haze: 'rgba(214,246,232,0.38)', oneway: '#b98a52',
  },
  build: { x: 1, y: 1, w: 110, h: 39 },
  parTime: '35–55 s',
  stages: [{ x: 0, y: 0, w: 21, h: 40 }, { x: 21, y: 0, w: 30, h: 40 }, { x: 41, y: 0, w: 28, h: 12 }, { x: 69, y: 0, w: 43, h: 40 }],
};

// Under the Mountain. The mountain is one rock mass fused to the top of the world: there is no way over it, and its
// outer faces only climb into the ceiling. The route runs through a cave in clear left-to-right order: the mouth, the
// crystal hall (sprint the chasm or take the high ledges), the rising gallery, the glow lake, the exit tunnel and the
// valley beyond, with the flag on the far hill, fifty cells past the entrance.
const mountain: MapDef = {
  id: 'mountain',
  name: 'Under the Mountain',
  blurb: 'The peak is sealed to the sky. Go under it: crystal hall, rising gallery, glow lake, then out into the valley.',
  w: 116, h: 38, size: 'large', raceS: 120,
  terrain: paint(116, 38, g => {
    g.solid(1, 30, 12, 8); // spawn meadow
    g.solid(16, 31, 6, 7); g.solid(19, 29, 3, 2); // bank and boulder past the stream
    g.solid(22, 30, 11, 8); g.oneway(24, 25, 4); g.oneway(28, 21, 4); g.solid(30, 18, 3, 1); // approach; ledges up to the sealed high route
    g.solid(33, 14, 56, 24); g.solid(35, 8, 52, 6); g.solid(38, 3, 46, 5); g.solid(41, 0, 40, 3); // the mountain, sky to bedrock, stepping in toward its fused summit
    g.clear(33, 22, 9, 8); // cave mouth
    g.clear(40, 12, 17, 18); g.carve(48, 13, 8, 3); // crystal hall with a vaulted roof
    g.clear(46, 30, 5, 8); // the chasm
    g.solid(41, 28, 3, 2); g.solid(44, 26, 2, 1); g.solid(47, 24, 3, 1); g.solid(51, 26, 3, 1); g.solid(53, 28, 3, 2); // crystal ledges: the high line
    g.clear(56, 10, 15, 20); // rising gallery
    g.solid(59, 28, 3, 10); g.solid(62, 26, 3, 12); g.solid(65, 24, 6, 14); g.solid(61, 10, 3, 8); // steps up, stalactite pillar
    g.clear(70, 12, 15, 12); g.clear(72, 24, 9, 14); g.clear(81, 24, 4, 2); // glow lake chamber, the lake, far landing
    g.oneway(74, 25, 2); g.oneway(77, 24, 2); // stalagmite tops in the lake
    g.clear(85, 19, 4, 6); // exit tunnel out of the east face
    g.solid(89, 26, 5, 12); g.solid(94, 29, 6, 9); g.solid(103, 27, 4, 11); g.solid(107, 25, 8, 13); // valley and the far hill
  }),
  spawn: { x: 2, y: 27, w: 4, h: 3 },
  finish: { x: 109, y: 22, w: 3, h: 3 },
  wires: [
    { x: 26, y: 29, rot: 0, len: 2 }, // bramble on the approach
    { x: 46, y: 30, rot: 1, len: 3 }, // crystal shards down the chasm's left wall
    { x: 64, y: 25, rot: 3, len: 2 }, // the gallery's last step: jump cleanly
    { x: 96, y: 28, rot: 0, len: 2 }, // thorns in the valley
  ],
  decor: [
    { kind: 'peaks2', x: 0, y: 0, w: 116, h: 38, layer: 0 }, { kind: 'torch', x: 32, y: 26, layer: 1 }, { kind: 'torch', x: 89, y: 22, layer: 1 },
    { kind: 'crystals', x: 42, y: 12, w: 14, h: 18, layer: 1 }, { kind: 'crystals', x: 57, y: 10, w: 13, h: 18, layer: 1 }, { kind: 'crystals', x: 71, y: 12, w: 13, h: 12, layer: 1 },
    { kind: 'glowshrooms', x: 59, y: 28, w: 12, layer: 1 }, { kind: 'lake', x: 72, y: 27, w: 9, h: 11, layer: 1 }, { kind: 'dust', x: 34, y: 10, w: 54, h: 20, layer: 2 },
    { kind: 'bats', x: 40, y: 12, w: 44, h: 6, layer: 2 }, { kind: 'flowers', x: 2, y: 30, w: 10, layer: 1 }, { kind: 'flowers', x: 107, y: 25, w: 7, layer: 1 },
    { kind: 'birds', x: 90, y: 2, w: 26, h: 6, layer: 0 },
  ],
  materials: [{ x: 33, y: 0, w: 56, h: 38, m: 'peak' }, { x: 33, y: 22, w: 9, h: 8, m: 'cave' }, { x: 39, y: 10, w: 50, h: 28, m: 'cave' }],
  theme: {
    skyTop: '#ff9e7a', skyBottom: '#ffe1a6', far: '#8b6fb0', far2: '#b48fc9', mid: '#5c4a86', terrain: '#6f6a8a', terrainEdge: '#9fd87a', terrainDark: '#2e2a44',
    accent: '#ffb347', accent2: '#5ef2ff', accent3: '#ff6fd8', light: '#ffd9a0', haze: 'rgba(255,214,190,0.32)', oneway: '#c7a3ff',
  },
  build: { x: 1, y: 1, w: 114, h: 37 },
  parTime: '35–55 s',
  stages: [{ x: 0, y: 0, w: 33, h: 38 }, { x: 33, y: 0, w: 24, h: 38 }, { x: 57, y: 0, w: 14, h: 38 }, { x: 71, y: 0, w: 18, h: 38 }, { x: 89, y: 0, w: 27, h: 38 }],
};

// Tropical Island. Start on a boat out at sea; the water kills. Hop the floating beach ball to the shore, cross the
// beach (chairs, a picnic, parasols) and climb the jungle trees: the flag is on the last canopy. Fifteen seconds into
// the round a tsunami floods everything below the canopies for fifteen seconds, then ebbs for fifteen, and so on.
// The ceiling is high, so a tall enough tower of blocks is also a way to ride it out.
const tropicalTree = (g: { solid: (x: number, y: number, w: number, h: number) => void; oneway: (x: number, y: number, w: number) => void }, tx: number, top: number, cx: number, cw: number) => {
  g.solid(tx, top + 2, 2, 38 - (top + 2)); // trunk down to the jungle floor
  g.oneway(cx, top, cw); // leafy canopy: jump up through it, stand on it
  for (let r = 36; r >= top + 2; r -= 2) g.oneway(tx - 3, r, 3); // vine rungs up the left of the trunk
};
const tropical: MapDef = {
  id: 'tropical',
  name: 'Tropical Island',
  blurb: 'Leap from the boat to the beach ball to the shore, then climb the jungle trees before the tsunami hits (15 s in, every 30 s).',
  w: 120, h: 48, size: 'large', raceS: 120,
  terrain: paint(120, 48, g => {
    g.solid(1, 38, 11, 1); g.solid(2, 39, 9, 1); g.solid(1, 35, 2, 3); // the boat: deck, hull, wheelhouse
    g.solid(22, 38, 40, 10); // the beach
    g.solid(28, 37, 2, 1); g.solid(28, 36, 1, 1); g.solid(41, 37, 2, 1); g.solid(41, 36, 1, 1); // beach chairs (seat + backrest)
    g.solid(35, 37, 1, 1); // the picnic basket
    g.oneway(45, 34, 3); g.oneway(51, 33, 3); // beach parasols
    g.solid(56, 37, 4, 1); g.solid(58, 36, 2, 1); // the dune at the edge of the jungle
    g.solid(62, 38, 57, 10); // jungle floor
    tropicalTree(g, 64, 18, 60, 10); tropicalTree(g, 76, 17, 72, 10); tropicalTree(g, 88, 16, 84, 10); tropicalTree(g, 100, 16, 96, 8); tropicalTree(g, 111, 16, 105, 13);
  }),
  spawn: { x: 3, y: 35, w: 4, h: 3 },
  finish: { x: 110, y: 13, w: 3, h: 3 },
  wires: [{ x: 58, y: 35, rot: 0, len: 2 }], // sea urchins washed up on the dune
  decor: [
    { kind: 'sun', x: 90, y: 2, layer: 0 }, { kind: 'mast', x: 6, y: 30, layer: 1 }, { kind: 'parasolpole', x: 46, y: 35, layer: 1 }, { kind: 'parasolpole', x: 52, y: 34, layer: 1 },
    { kind: 'blanket', x: 33, y: 37, w: 4, layer: 1 }, { kind: 'palms', x: 0, y: 0, w: 120, h: 48, layer: 0 },
  ],
  materials: [
    { x: 1, y: 35, w: 11, h: 5, m: 'boat' }, { x: 22, y: 38, w: 40, h: 10, m: 'sand' }, { x: 56, y: 36, w: 4, h: 2, m: 'sand' },
    { x: 28, y: 36, w: 2, h: 2, m: 'chair' }, { x: 41, y: 36, w: 2, h: 2, m: 'chair' }, { x: 35, y: 37, w: 1, h: 1, m: 'basket' },
    { x: 45, y: 34, w: 3, h: 1, m: 'parasol' }, { x: 51, y: 33, w: 3, h: 1, m: 'parasol2' }, { x: 62, y: 38, w: 57, h: 10, m: 'jungle' },
    { x: 60, y: 16, w: 58, h: 3, m: 'canopy' }, { x: 64, y: 18, w: 2, h: 20, m: 'trunk' }, { x: 76, y: 18, w: 2, h: 20, m: 'trunk' }, { x: 88, y: 18, w: 2, h: 20, m: 'trunk' },
    { x: 100, y: 18, w: 2, h: 20, m: 'trunk' }, { x: 111, y: 18, w: 2, h: 20, m: 'trunk' }, { x: 57, y: 18, w: 60, h: 20, m: 'vines' },
  ],
  theme: { skyTop: '#2fb6ff', skyBottom: '#bff3ff', far: '#3aa58a', mid: '#2b8a6e', terrain: '#e9cf8f', terrainEdge: '#fff1c2', terrainDark: '#b98f4f', accent: '#ff7a59', oneway: '#3fb54f', accent2: '#1f8a5c', accent3: '#ffd25e', light: '#fffbe0' },
  build: { x: 1, y: 1, w: 118, h: 46 },
  parTime: '15–25 s',
  fx: {
    liquid: { kind: 'water', level: 39 * 48 + 30 },
    tsunami: { start: 15, on: 15, off: 15, rise: 1.6, high: 910, warn: 3 },
    ball: { x: 16, w: 2, h: 2, sink: 18 },
  },
};

// Magma Works. Basalt columns rise out of a lava lake; lava geysers erupt from the gaps on their own timers, bubbling
// just before they blow. Read the rhythm and jump between eruptions.
const magmaIslands: [number, number, number][] = [[14, 30, 4], [21, 29, 3], [27, 30, 4], [34, 28, 3], [40, 27, 4], [47, 28, 3], [53, 26, 4], [60, 27, 3], [66, 25, 4], [73, 26, 3], [79, 24, 4], [86, 25, 3], [92, 23, 4], [99, 24, 3], [105, 22, 4]];
const magma: MapDef = {
  id: 'magma',
  name: 'Magma Works',
  blurb: 'Hop the basalt columns over a lava lake. Geysers erupt from the gaps on a rhythm: watch them bubble, then go.',
  w: 120, h: 40, size: 'large', raceS: 120,
  terrain: paint(120, 40, g => {
    g.solid(1, 31, 10, 9); // the spawn crag
    for (const [x, y, w] of magmaIslands) g.solid(x, y, w, 40 - y); // basalt columns down into the lake
    g.solid(111, 21, 8, 19); // the summit forge
    g.solid(44, 1, 14, 12); g.solid(48, 13, 6, 3); g.solid(82, 1, 12, 10); // smoke-stained rock overhead
  }),
  spawn: { x: 3, y: 28, w: 4, h: 3 },
  finish: { x: 113, y: 18, w: 3, h: 3 },
  wires: [{ x: 39, y: 30, rot: 3, len: 2 }], // obsidian shards low on a column's face
  decor: [{ kind: 'embers', x: 0, y: 0, w: 120, h: 40, layer: 2 }, { kind: 'volcano', x: 0, y: 0, w: 120, h: 40, layer: 0 }],
  materials: [{ x: 0, y: 0, w: 120, h: 40, m: 'basalt' }, { x: 111, y: 21, w: 8, h: 19, m: 'forge' }],
  theme: { skyTop: '#1a0606', skyBottom: '#6b1a0c', far: '#3a0d08', mid: '#561a10', terrain: '#3b2f33', terrainEdge: '#ff7a2f', terrainDark: '#1a1214', accent: '#ffb347', oneway: '#8a5a3c', accent2: '#ff4a1c', accent3: '#ffd25e', light: '#ffd9a0' },
  build: { x: 1, y: 1, w: 118, h: 39 },
  parTime: '30–45 s',
  fx: {
    liquid: { kind: 'lava', level: 35 * 48 + 24 },
    geysers: [12, 19, 32, 38, 51, 58, 71, 77, 90, 97, 103, 109].map((x, i) => ({ x, top: 15, period: 4.5, on: 1.3, phase: (i * 1.7) % 4.5, warn: 0.9 })),
  },
};

// Orbital Lab. A space station of modules strung over the void. The gaps between them are zero-g bays (gravity at 40%):
// a sprint jump floats right across. Miss and you drift down into nothing.
const orbitalModules: [number, number, number][] = [[1, 30, 12], [22, 30, 10], [41, 28, 9], [59, 29, 8], [76, 27, 9], [94, 28, 8], [106, 27, 9]];
const orbital: MapDef = {
  id: 'orbital',
  name: 'Orbital Lab',
  blurb: 'Float through the zero-g bays between station modules. Sprint before you jump: in low gravity you sail across.',
  w: 116, h: 40, size: 'large', raceS: 120,
  terrain: paint(116, 40, g => {
    g.solid(1, 1, 114, 6); // the station's outer hull overhead
    for (const [x, y, w] of orbitalModules) g.solid(x, y, w, 40 - y);
    g.solid(26, 27, 1, 3); g.solid(45, 25, 2, 1); g.solid(62, 26, 1, 3); g.solid(80, 24, 2, 1); g.solid(97, 25, 1, 3); // consoles and crates
    g.oneway(23, 24, 3); g.oneway(78, 21, 3);
  }),
  spawn: { x: 3, y: 27, w: 4, h: 3 },
  finish: { x: 109, y: 24, w: 3, h: 3 },
  wires: [{ x: 58, y: 31, rot: 3, len: 2 }], // a sparking cable low on a module's side
  decor: [{ kind: 'stars', x: 0, y: 0, w: 116, h: 40, layer: 0 }, { kind: 'planet', x: 70, y: 8, layer: 0 }],
  materials: [{ x: 0, y: 0, w: 116, h: 40, m: 'hull' }],
  theme: { skyTop: '#05071a', skyBottom: '#1a1f4a', far: '#151a3a', mid: '#20285a', terrain: '#7c87a8', terrainEdge: '#5ef2ff', terrainDark: '#2b3150', accent: '#5ef2ff', oneway: '#9ab0ff', accent2: '#ff6fd8', accent3: '#ffd25e', light: '#d8f6ff' },
  build: { x: 1, y: 7, w: 114, h: 33 },
  parTime: '25–40 s',
  fx: {
    lowGrav: [[13, 9], [32, 9], [50, 9], [67, 9], [85, 9]].map(([x, w]) => ({ x: x - 2, y: 7, w: w + 4, h: 33, mul: 0.4 })),
  },
};

// Sandstorm Dunes. Rolling dunes, sinkholes and cactus patches under a hard sun. Every twelve seconds a sandstorm gust
// howls in from the east for a few seconds and shoves everyone back: brace on the ground or get blown into a pit.
const dunes: MapDef = {
  id: 'dunes',
  name: 'Sandstorm Dunes',
  blurb: 'Cross the dunes and sinkholes. Every 12 s a sandstorm gust blows you back toward the start: brace, or ride it out in shelter.',
  w: 120, h: 36, size: 'large', raceS: 120,
  terrain: paint(120, 36, g => {
    g.solid(1, 30, 118, 6); // the desert floor
    g.blob(15, 31, 7, 3); g.blob(60, 31, 6, 2); g.blob(92, 31, 8, 3); // dunes
    g.clear(28, 30, 4, 6); g.clear(52, 30, 5, 6); g.clear(78, 30, 4, 6); // sinkholes
    g.solid(40, 26, 6, 4); g.solid(66, 25, 3, 5); g.solid(84, 26, 5, 4); // mesas and a rock pillar
    g.solid(106, 24, 13, 12); // the oasis mesa
  }),
  spawn: { x: 3, y: 27, w: 4, h: 3 },
  finish: { x: 111, y: 21, w: 3, h: 3 },
  wires: [{ x: 35, y: 29, rot: 0, len: 2 }, { x: 47, y: 29, rot: 0, len: 1 }, { x: 74, y: 29, rot: 0, len: 2 }, { x: 101, y: 29, rot: 0, len: 2 }], // cactus patches
  decor: [{ kind: 'sandsun', x: 80, y: 3, layer: 0 }, { kind: 'dunesbg', x: 0, y: 0, w: 120, h: 36, layer: 0 }],
  materials: [{ x: 0, y: 0, w: 120, h: 36, m: 'desert' }, { x: 106, y: 24, w: 13, h: 12, m: 'mesa' }, { x: 40, y: 26, w: 6, h: 4, m: 'mesa' }, { x: 84, y: 26, w: 5, h: 4, m: 'mesa' }, { x: 66, y: 25, w: 3, h: 5, m: 'mesa' }],
  theme: { skyTop: '#ff9f43', skyBottom: '#ffe3a3', far: '#e8a86a', mid: '#d38b4f', terrain: '#e2b36f', terrainEdge: '#fff0c4', terrainDark: '#a8743e', accent: '#2f8f4e', oneway: '#b98a52', accent2: '#c0562e', accent3: '#ffd25e', light: '#fff4c4' },
  build: { x: 1, y: 1, w: 118, h: 35 },
  parTime: '25–40 s',
  fx: { gusts: { start: 8, period: 12, on: 3.5, accel: -1300, warn: 2 } },
};

/** Test lab: flat floor, a 12-cell wall, a pit. Not offered in the lobby; used by automated tests. */
const lab: MapDef = {
  id: 'lab', name: 'Test Lab', blurb: 'Automated test arena.', w: 40, h: 20,
  terrain: [...border(40, 20), s(1, 16, 38, 4), s(20, 4, 2, 12)],
  spawn: { x: 2, y: 13, w: 3, h: 3 }, finish: { x: 35, y: 13, w: 3, h: 3 }, wires: [], decor: [],
  theme: rooftop.theme, build: { x: 1, y: 1, w: 38, h: 19 }, parTime: '-',
};

/** Test pit: 9 cells, too wide to jump; a shuttle in the pit row ferries players across. Not offered in the lobby. */
const labGap: MapDef = {
  id: 'lab_gap', name: 'Test Gap', blurb: 'Automated test arena.', w: 44, h: 20,
  terrain: [...border(44, 20), s(1, 14, 14, 6), s(24, 14, 19, 6)],
  spawn: { x: 2, y: 11, w: 3, h: 3 }, finish: { x: 38, y: 11, w: 3, h: 3 }, wires: [], decor: [],
  theme: rooftop.theme, build: { x: 1, y: 1, w: 42, h: 19 }, parTime: '-',
};
/** Test chasm: 14 cells, crossable by riding a Ferris wheel whose pivot sits in the middle of the gap. */
const labWheel: MapDef = {
  id: 'lab_wheel', name: 'Test Wheel', blurb: 'Automated test arena.', w: 44, h: 22,
  terrain: [...border(44, 22), s(1, 15, 14, 7), s(29, 15, 14, 7)],
  spawn: { x: 2, y: 12, w: 3, h: 3 }, finish: { x: 38, y: 12, w: 3, h: 3 }, wires: [], decor: [],
  theme: rooftop.theme, build: { x: 1, y: 1, w: 42, h: 21 }, parTime: '-',
};

export const MAPS: Record<string, MapDef> = { rooftop, factory, forest, frost, oak, mountain, tropical, magma, orbital, dunes, lab, lab_gap: labGap, lab_wheel: labWheel };
export const MAP_LIST: readonly MapDef[] = [oak, mountain, tropical, magma, orbital, dunes, rooftop, factory, forest, frost];
export function getMap(id: string): MapDef { return MAPS[id] ?? rooftop; }
/** Lobby-selectable maps only (test arenas are never offered or accepted). */
export function selectableMap(id: string | undefined): boolean { return !!id && MAP_LIST.some(m => m.id === id); }
