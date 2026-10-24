# Trap Race

A 2D competitive party platformer for 2–6 players. Every round, everyone drafts one item from a shared pool, places it on the same course, then races from START to the flag. Whatever survives stays, so the course gets nastier each round. The question each round: can you build something dangerous that you can get past and your opponents can't?

Play it from [Open Arcade](https://open-arcade.up.railway.app).

## Run it

```bash
npm install
npm run dev        # game server on :8080 (reloads) + Vite client on :5173 (proxies /ws)
npm run build      # client to dist/client, server bundle to dist/server
npm start          # production server: serves the client and the WebSocket on $PORT (default 8080)
npm test           # unit, simulation, match and network integration tests (vitest)
npm run e2e        # two-browser end-to-end checks (needs `npm run build` and a Chromium; see tests/e2e/run.mjs)
npm run typecheck
```

To play on two devices, run `npm run build && npm start` on one machine and open `http://<that-machine's-LAN-IP>:8080` on both. One player clicks Create Room and shares the code or the invite link; the other uses Join Room by Code. In production both just open the deployed URL.

Useful tools: `npx tsx scripts/map-ascii.ts rooftop` prints a map with its reachable standing spots and best route; `npx tsx scripts/map-audit.ts rooftop 3` searches thousands of single and accumulated construction placements near spawn and flag for shortcuts; `npx tsx scripts/bot-race.ts medium 4` races bots on every unmodified map; `npx tsx scripts/bot-race-large.ts 3` times bots on the large maps; `npx tsx scripts/bot-bench.ts 4 medium` plays full bot matches and reports finish rates and placement validation cost; `npx tsx scripts/profile-movers.ts mountain 6 4` profiles a six-player race with shuttles and wheels. `node tests/e2e/movers.mjs` runs the two-browser checks for the moving platforms (needs `npm run build`).

## Controls

| Action | Keys |
| --- | --- |
| Move | A/D or ←/→ |
| Jump / wall jump | Space, W or ↑ (hold for a higher jump) |
| Sprint | Hold Shift |
| Drop through one-way platform | S or ↓ (no jump needed) |
| Build: aim / place / rotate | Mouse (or arrow keys) / click, Enter or E / right-click, R or Q (Shift+R reverses) |
| Build: flip sniper facing, zoom | F, Z or mouse wheel |
| Spectate next player | Tab |
| Practice / sandbox: instant retry / respawn | T |
| Sandbox: item menu | M |
| Emote wheel | Hold G, scroll the mouse wheel to choose, release to play |
| Menu | Esc (pauses only in solo practice) |

Every binding can be changed in Settings. On phones and tablets: hold ◀/▶ to move, RUN to sprint, JUMP to jump (multi-touch, so you can run and jump together), ▼ to drop through one-way platforms. Building on touch: tap a cell or drag anywhere to nudge the preview, Zoom for precision, then tap Place. Phones play in landscape; Play fullscreen on the menu hides the browser bars where supported. Gamepads work for movement (stick or d-pad, A jump, X/RB/RT sprint). Wall sliding is automatic when you fall against a wall; jump off it, steer back, and you can climb the same wall as many times as you like.

## Match rules

The host picks a **score to win** from 5 to 15 (default 10) and an optional **round limit** (3 to 30). Either can be switched off, never both: the lobby disables the last remaining Off and the server refuses it. The first player to reach or pass the score wins at once, even mid-race, and players who cross it on the same tick share the win. When the round limit is reached the most points wins, then most finishes, then lowest total time, else a shared win. **Individual win requirements** (a lobby checkbox) give any player or bot their own points to win as a handicap; at a round limit players are then ranked by the share of their own requirement they earned. Phases are server-owned: lobby → draft (humans 20 s, then the AI up to 3.5 s) → build (35 s) → countdown (3 s) → race (90 s; 120 s on the two large maps) → results → next round, until someone reaches the target. Draft and build end early when everyone is done.

**Draft.** One shared pool of 5–10 individual cards per round, always at least one per participant, balanced across construction, hazards, utilities and demolition. Humans choose first: the server refuses bot claims until every human has picked, timed out or disconnected (those get the usual seeded random card first), then the AI picks from what is left. The first valid claim on a card wins it atomically; everyone gets exactly one item. After a round where nobody finished (or if the route check finds the course shut), the next pool is guaranteed a bomb. Bombs also turn up every few rounds.

**Build.** Everything snaps to one 48 px grid. Nothing may overlap anything else, solid or not; touching edges is fine. The striped zones around START and FINISH are off limits. Whether the course stays finishable is not a placement rule: a legal placement may seal the course, and bombs are how it gets reopened. The route search (the same physics as the game from every reachable standing spot, a conservative sampled search) only guides bots and the draft mix. Rehearse lets you test the course locally without scoring while the build timer keeps running. There is no auto-placement: an item that is not placed before the build timer runs out is lost for that round.

**Race.** One life per race. Players never collide with each other. Dead and finished players spectate. A disconnected player's avatar stays in the race with no input; after a 20 s grace period they're eliminated for that race (no immunity, no extra lives). Ties on the same simulation tick share first place. If a lethal contact and the finish happen on the same tick, the lethal contact wins.

## Scoring

| Event | Points | Rule |
| --- | ---: | --- |
| Finish | +1 | Reach the flag alive, once per round |
| First finisher | +0.4 | Earliest finish tick, in a round that started with 2+ competitors. Not paid to a sole finisher |
| Sole finisher | +0.6 | Exactly one finisher in a round that started with 2+ competitors, paid once nobody else can still finish. Replaces the first-finisher bonus (they never stack) |
| Trap elimination | +0.2 | Another player dies to a trap you own (crushes by your moving platforms included); once per victim, at most 3 eliminations per round |
| Banked coin | +1 per coin | Carry the coin to the flag alive; picking it up is worth nothing |
| Comeback | +1 | Reach the flag after missing it 4 or more rounds in a row (competitive rounds); the streak resets on a finish |

Bots count as competitors. Solo practice (one human, no bots) shows finishes, times and coins but no first, sole or trap bonuses. Self-eliminations, falls and map wire credit nobody. A fall within 3 s of a black hole pull credits that hole's owner. Scores are integer tenths internally (0.2 = 2) so totals never show float artefacts. Scoring is computed on the server from the round's unique event IDs, so duplicate events can't double count; after every tick with a scoring event the target is checked. Competitiveness comes from the roster at round start.

Match winner: highest score, then most finishes, then lowest total time across successful finishes, else a shared victory.

## Items

All sizes are grid cells. Every item rotates in quarter turns except the tripod sniper and the black hole.

- **Construction:** blocks 1×1, 1×2, 2×2, 2×3, 3×3; planks 1 thick and 3, 5 or 7 long; an L block (5 cells in a 3×3 box, inner corner genuinely empty); stairs; one-way platform; spring pad; conveyor; moving platform 3×1 (6 cells end to end, through walls); crumbling platform (breaks on its second interaction for the rest of the round); Shuttle Block; Ferris Wheel (below).
- **Shuttle Block:** one solid 2×1 block (1×2 after a quarter turn) that slides 3 cells along its arrow and back, cosine-eased so it slows to a stop at each end. One card, one platform.
- **Ferris Wheel:** one card places a pivot (no collision, also the bomb handle) and four solid 2×1 gondolas 90° apart that orbit it and stay level. Odd rotations stand the gondolas upright (1×2); F flips clockwise/counter-clockwise. Pivot, spokes and the space between gondolas are genuinely empty.
- **Hazards:** spiky oval 3×1; retracting spikes (a solid base block with spikes on its outward face); saw rail; laser gate (beam stops at solids and safety zones); swinging axe (solid 1×1 pivot block); black hole (strong softened pull on players and projectiles, blocked by solids, small lethal core); tripod sniper (must sit on a stationary solid block's top face, fires every 2.5 s of sim time, the shot resolves instantly, pierces players and stops at blocks, bent by black holes); cannon (floats, gravity arc, stops at first player); crossbow (floats, one slow arrow per second that breaks on the first player, shield or not); barbed wire 1/2/3 (bolts to one block edge, unsupported segments are trimmed, lethal even while wall sliding).
- **Utility:** coins (carry to the flag to bank; dropped where the carrier dies; reset to their placed spot next round unless banked: a banked coin is gone for the rest of the match); speed, jump, shield and slow-pulse stations (first collector each race, refill next race).
- **Demolition:** bombs 1×1, 2×2, 3×3. Remove every player-built object touching the area (and snipers or wire bolted to them). Never touch map terrain or map wire. Removal is permanent for the match.

### Moving platforms in detail

Shuttles and wheels move as a pure function of race ticks since GO, stored on the placed object as its motion definition (`mv`: period, travel or radius, direction). The server sim, client prediction, rendering, bots and the route probe all evaluate the same function, so the four gondolas can't drift apart and every client agrees. Every race restarts them from their GO pose; during building they animate on a local clock, which never affects validity.

| Setting (`MOVERS` in `shared/config.ts`) | Default | Why |
| --- | --- | --- |
| Shuttle travel | 3 cells | a 5-cell lane: long enough to ferry across a pit, short enough to read |
| Shuttle travel | 6 cells, 384-tick (6.4 s) round trip | was 3 cells in 3.2 s: double the distance at the same ~141 px/s peak |
| Wheel radius | 3 cells (144 px) | gondolas are ≥204 px apart, never touch, and riders keep >100 px headroom under the next gondola |
| Wheel lap | 480 ticks (8 s) | ~113 px/s along the orbit |
| Inherited velocity | 0 px/s | jumping off keeps normal jump feel; riders move only by the platform's exact per-tick displacement |

Moving platforms pass through walls and blocks; nothing reserves their path. A shuttle or moving platform may start partly inside a wall but not wholly; a wheel needs at least one gondola whose whole starting body is in legal open space, and the others may start inside blocks. The whole route must stay on the map and out of the safety zones. Nothing bolts onto moving platforms. A platform that catches a player shoves them by the smallest separating move if there is room (at most 8 px); if there isn't, they are squeezed against something solid and die once (`crush`, credited to the platform's owner, shields don't help). Projectiles hit the moving bodies using relative motion (no tunnelling) and pass through pivots and spokes. Bombs hit a platform at its GO pose, which the build view freezes on while you hold a bomb; one hit on any gondola or the pivot removes the whole wheel with its lane and bodies.

The route probe and the bots treat each platform child as a node: timed edges (board at a phase, ride, alight at a phase) are simulated against the real future poses at sampled departure ticks, and any ordinary move that crosses a lane is re-checked as a timed move. Bots wait at the right spot for the right tick, stay centred while riding, and jump off where the edge says.

Projectiles collide with every solid (L blocks use their real cells), are absorbed at safety zones, and never damage the environment. The slow pulse halves timed traps only; snipers, arrows, cannonballs and black holes are unaffected, and lasers only have their off time stretched.

## Maps

Six maps. All run left to right with the flag at the far end; map traps are only barbed wire.

| Map | Size (cells) | Character |
| --- | --- | --- |
| The Great Oak | 112 × 40 (large) | Meadow, bramble hollow, a giant oak you must build over, the glade and creek, the sunlit hill. |
| Under the Mountain | 116 × 38 (large) | A peak fused to the sky; the route is a cave: crystal hall, rising gallery, glow lake, exit tunnel, valley. |
| Rooftop Run | 72 × 28 | Rebuilt: low roofs east, the clock tower or its fire escape, then the high skyline to the flag. |
| Factory Shift, Forest Heights, Frostline Ridge | 64 × 26 | Unchanged. |

**Audit (Oct 2026).** Every existing map was 64 × 26. With the real movement (sprint, air steering, wall slides, unlimited same-wall jumps) and a search over every legal plank/block/stair placement near spawn and flag, one piece at a time and accumulated over three rounds (`scripts/map-audit.ts`): Rooftop Run's course looped back so the flag sat 8 cells across and 14 up from spawn, and one upright Plank 7 beside the left wall turned the 18.6 s course into a 5.2 s shaft climb (two planks: 4.5 s). Factory, Forest and Frost only allowed local savings of 5–9%. The rebuilt Rooftop allows 1–3%. On the large maps, no piece near spawn or flag opens a route on the Oak; the best piece on the Mountain saves 2%.

**The Great Oak** is solid from canopy top to the bottom of the map, and its canopy overhangs the trunk: climbing the trunk ends under the leaves, and the canopy's outer face starts eight rows above the left branch. Building on the branch tip bridges it: one upright Plank 5 or 7, a Spring Pad or a vertical Shuttle does it alone; two Plank 3s or a 2×3 plus a 2×2 block also work. While there is no full route, every draft offers each player a building card, bots build toward the frontier, races are 45 s scouting runs, and no bomb is forced. Bounds, overlap and safety-zone rules still apply.

**Under the Mountain**'s rock is one mass fused to the top of the world; a unit test proves there is no open-air path from start to flag once the cave interior is blocked, so there is no roof route or seam.

Timers: bots finish Under the Mountain in ~21 s and the bridged Oak in ~28 s (medians, `scripts/bot-race-large.ts`), against 12–15 s on the standard maps, so the large maps get 120 s instead of 90 s.

Map definitions are data in `shared/maps.ts` (the large maps use a small cell painter for organic shapes). Their art (parallax layers, materials, ambient life) is in `client/src/scenery.ts`; ambient life is capped, follows the particle setting, freezes with reduced motion and never collides.

## Bots

Server-side bots draft, build and race through the same code paths as humans. They race by producing input bits for the same physics: they follow recorded movement primitives from the navigation graph with closed-loop steering, wait for timed hazards, take coin detours when greedy, and replan or blacklist an edge when stuck. Measured on unmodified maps (`scripts/bot-race.ts`, 6 bots per race, seeded): easy, medium and hard all finish 94–100%. On the large maps (`scripts/bot-race-large.ts`, 3 seeds × 6 bots): Under the Mountain 94–100%, the bridged Oak 89–100%. Across pits only a moving platform can cross (test arenas), bots finish 94–100% by boarding, riding and leaving shuttles and wheels. On built-up courses from full bot matches, medium bots finished 19–50% of their races.

| Difficulty | Reaction | Hazard timing check | Mistakes/s | Route noise | Align tolerance | Coin greed | Risk tolerance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Easy | 0.45 s | 45% | 0.05 | 0.6 | 3 px | 0.2 | 0.6 |
| Medium | 0.22 s | 90% | 0.01 | 0.25 | 2 px | 0.5 | 0.3 |
| Hard | 0.10 s | 100% | 0 | 0.05 | 1.5 px | 0.8 | 0.15 |

## Architecture

- `shared/` holds the rules both sides use: `config.ts` (all tuning), `items.ts`, `maps.ts`, `world.ts` (grid, occupancy, collision grid), `physics.ts` (one fixed-step movement function), `hazards.ts`, `race.ts` (deterministic race sim), `placement.ts`, `nav.ts` (route probes), `scoring.ts`, `protocol.ts` (typed messages and validation).
- `server/room.ts` is rooms and the match phase machine, with no Node APIs, so solo practice runs the same code in the browser. `server/bots.ts` is the AI. `server/index.ts` is the HTTP static server, `/healthz`, the WebSocket at `/ws`, rate limits, reconnect tokens and the 60 Hz loop.
- `client/src/` is the canvas renderer, prediction and interpolation (`game.ts`), DOM UI (`ui.ts`), art, audio and input.

Networking: clients send sequenced input bits, never positions, deaths, finishes or scores. The server simulates at 60 Hz and sends snapshots at 20 Hz with the last processed input. The client predicts only its own movement with the shared physics, replays unacknowledged inputs on each snapshot, smooths small corrections, and interpolates everyone else about 100 ms behind. Messages are schema-checked, capped at 8 KB and rate limited. Reconnect tokens are random 144-bit values; a room code alone never grants an identity or host rights.

**Limitations.** Rooms live in memory in one process. A redeploy or restart ends every active room, and the service must run as a single replica, since there's no cross-instance room coordination. Placement checks are cheap shape rules now (no route search on the request path); the route graph is refreshed once before each draft and race. On phones and tablets the game plays in landscape with on-screen controls (verified in Chromium phone and tablet emulation with multi-touch, not yet on physical devices); portrait shows a rotate prompt. The legacy Moving Platform is still treated as standing still at its start by the route check (Shuttles and Wheels are fully timed). Validation on the large maps: ordinary pieces ~100–200 ms, a wheel up to ~0.8 s (timed edges); measured with 10 moving items on a large map: median 130–200 ms, max 711 ms. A six-player race with 22 moving bodies costs ~0.03 ms per sim tick plus ~0.02 ms for six bots (`scripts/profile-movers.ts`). The server precomputes every map's route graph at start-up (~3 s). Timed edges sample departures every 32+ ticks, so the probe can miss a route that needs a very precise moment (conservative).

## Credits

All art, sound and music are original and generated in code (`client/src/art.ts`, `client/src/audio.ts`). No third-party assets.

## October 2026 gameplay update

Ferris wheels need one gondola in open space, and moving platforms run through walls. Being squeezed by a platform kills. Sniper shots are instant, with a short muzzle glint. Retracting spikes sit on a solid base. Banked coins are spent. The axe has a solid pivot. The crossbow fires once a second with slow arrows. The dart launcher is gone. Shuttles travel 6 cells and the 3×1 platform 6 cells. Crumbling platforms take two hits. The spike strip became a 3×1 spiky oval. Humans draft before the AI. Bonuses are 0.2 / 0.4 / 0.6, and matches play to a score target of 5–15. Black holes are stronger and bend projectiles. Placements may make the course impossible. Old saved worlds are migrated (`migrateSnapshot` in `shared/world.ts`). Tests: `tests/unit/update.test.ts`, `tests/unit/rider.test.ts`, `tests/e2e/update.mjs`. Load profile: `npx tsx scripts/profile-load.ts mountain`.

Latency: the client pings the game server once a second over the gameplay socket and shows the median of the last 60 round trips. The developer overlay (Settings → Developer overlay) adds p95, jitter, timeouts and the server region. `/healthz` reports the region, the simulation tick cost (p50/p95/max) and event-loop delay.

## Emotes and animations

Ten emotes: wave, dance, spin, flex, laugh, cry, point, heart, thumbs up and floss. Hold G (rebindable) during countdown, race and results to open the emote wheel, scroll the mouse wheel (or point at a slice) to choose, and let go to play it. On touch, tap the Emote button and then a slice. They're cosmetic. The server relays them to the room with a 0.9 s cooldown and rejects anything that isn't a known emote. An emote ends after 2.6 s or the moment you move. Characters also blink, glance around, tap a foot after standing still a while, and crouch ready during the countdown. They skid when braking out of a turn and flail when falling. Finishers dance on the flag, and the match-over screen shows the winners dancing. Idle arms now hang at the sides; they used to point up behind the head. Browser check: `node tests/e2e/emotes.mjs`.

## October 2026 batch update

**Controls.** Emotes moved to a hold-to-open wheel (G, rebindable): scroll the mouse wheel or point at a slice, release to play; on touch, tap Emote and a slice. Down alone drops through one-way platforms. Auto-placement of timed-out items is gone. The scouting-run banner is gone. Barbed wire is easier to read (same 11 px strip). Eight new skins (Cat, Bear, Pirate, Alien, Wizard, Chef, Dino, Bee): 16 in all.

**Item changes.** A Ferris wheel needs only one gondola clear of walls (its pivot may sit in a wall). Saw rails take no grid squares: lay them through objects and build over them; the saw passes through. A broken crumbling platform vanishes whole. Shuttles travel 9 cells. Barbed wire can be bolted to Moving Platforms and Shuttle Blocks and rides with them through walls. Crossbows sit on a solid mount you can stand on.

**Scoring and settings.** See Match rules and Scoring above: round limit, individual win requirements, comeback point, sole/first no longer stack. Protocol version 6.

**Death effects.** Every cause of death has its own animation and sound (crush, sniper/crossbow, dart, cannonball, retracting spikes, barbed wire, spiky oval, void, drowning, tsunami, ghost, black hole, laser, saw/axe, lava/geyser), driven by the server's death event so every client plays the same one.

**New items.** Paper Plane Maker (planes never kill, can be ridden, crumple on contact; fans make them strafe), Fan 3×1 (wind that levitates, pushes players and projectiles), Gravestone (touch it and a ghost hunts you through walls), Dart Turret (aims at the closest visible player within 6 cells; darts pierce), Ice 3 / Ice 5 (slippery overlay on any top surface, moving platforms included). Planes use fixed mover slots so riders and snapshots stay stable; everything is server-authoritative and in the snapshots.

**Sandbox.** Main menu > Sandbox: any map, M opens every item, place freely, T respawns, no scoring. Runs entirely in the browser with the real rules and physics.

**New maps.** Tropical Island (boat, sea, beach ball, beach, jungle trees; a tsunami 15 s in, 15 s up and 15 s down on repeat), Magma Works (lava lake and timed geysers), Orbital Lab (zero-g bays over the void), Sandstorm Dunes (sinkholes, cactus wire and a gust every 12 s). Mechanics are pure functions of the race tick (`shared/mapfx.ts`). `npx tsx scripts/bot-race-new-maps.ts 2` checks routes and bot finishes (medium bots: Magma 8/8, Orbital 8/8, Dunes 7/8, Tropical about 75%; hard bots 8/8 everywhere).

Tests: `tests/unit/batch.test.ts` (43 tests), browser `tests/e2e/batch.mjs` (two clients in sync on new items, effects and the tsunami; sandbox menu), `tests/e2e/emotes.mjs` (wheel).
