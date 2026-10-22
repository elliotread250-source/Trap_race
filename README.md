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

Useful tools: `npx tsx scripts/map-ascii.ts rooftop` prints a map with its reachable standing spots and best route; `npx tsx scripts/bot-race.ts medium 4` races bots on every unmodified map; `npx tsx scripts/bot-bench.ts 4 medium` plays full bot matches and reports finish rates and placement validation cost.

## Controls

| Action | Keys |
| --- | --- |
| Move | A/D or ←/→ |
| Jump / wall jump | Space, W or ↑ (hold for a higher jump) |
| Sprint | Hold Shift |
| Drop through one-way platform | S or ↓ + Jump |
| Build: aim / place / rotate | Mouse (or arrow keys) / click, Enter or E / right-click, R or Q (Shift+R reverses) |
| Build: flip sniper facing, zoom | F, Z or mouse wheel |
| Spectate next player | Tab |
| Practice: instant retry | T |
| Menu | Esc (pauses only in solo practice) |

Every binding can be changed in Settings. Gamepads work for movement (stick or d-pad, A jump, X/RB/RT sprint). Wall sliding is automatic when you fall against a wall; jump off it, steer back, and you can climb the same wall as many times as you like.

## Match rules

Default 8 rounds (host can pick 3–12). Phases are server-owned: lobby → draft (20 s) → build (35 s) → countdown (3 s) → race (90 s) → results → next round → match results. Draft and build end early when everyone is done.

**Draft.** One shared pool of 5–10 individual cards per round, always at least one per participant, balanced across construction, hazards, utilities and demolition. The first valid claim on a card wins it atomically; everyone gets exactly one item. On timeout the server deals a seeded random leftover. After a round where nobody finished (or if the route check flags the course), the next pool is guaranteed a bomb. Bombs also turn up every few rounds.

**Build.** Everything snaps to one 48 px grid. Nothing may overlap anything else, solid or not; touching edges is fine. The striped zones around START and FINISH are off limits. A placement that removes every route to the flag is rejected: the server runs the same physics as the game from every reachable standing spot (walking, sprint jumps, air steering, short hops, same-wall wall-jump climbs and shaft zig-zags) and keeps only moves that still work when nudged 3 px. It's a conservative sampled search, not a proof, and it treats timed traps as passable because every timed trap has a guaranteed safe window. Rehearse lets you test the course locally without scoring while the build timer keeps running. Timed-out construction and utility items get a validated fallback spot; hazards and bombs are skipped with a notice.

**Race.** One life per race. Players never collide with each other. Dead and finished players spectate. A disconnected player's avatar stays in the race with no input; after a 20 s grace period they're eliminated for that race (no immunity, no extra lives). Ties on the same simulation tick share first place. If a lethal contact and the finish happen on the same tick, the lethal contact wins.

## Scoring

| Event | Points | Rule |
| --- | ---: | --- |
| Finish | +1 | Reach the flag alive, once per round |
| First finisher | +1 | Earliest finish tick, in a round that started with 2+ competitors |
| Sole finisher | +1 | Exactly one finisher in a round that started with 2+ competitors |
| Trap elimination | +1 | Another player dies to a trap you own; once per victim, max +3 per round |
| Banked coin | +1 per coin | Carry the coin to the flag alive; picking it up is worth nothing |

Bots count as competitors. Solo practice (one human, no bots) shows finishes, times and coins but no first, sole or trap bonuses. Self-eliminations, falls and map wire credit nobody. A fall within 3 s of a black hole pull credits that hole's owner. Scoring is computed on the server from the round's unique event IDs, so duplicate events can't double count. Competitiveness comes from the roster at round start.

Match winner: highest score, then most finishes, then lowest total time across successful finishes, else a shared victory.

## Items

All sizes are grid cells. Every item rotates in quarter turns except the tripod sniper and the black hole.

- **Construction:** blocks 1×1, 1×2, 2×2, 2×3, 3×3; planks 1 thick and 3, 5 or 7 long; an L block (5 cells in a 3×3 box, inner corner genuinely empty); stairs; one-way platform; spring pad; conveyor; moving platform (stops short of solids and safety zones); crumbling platform.
- **Hazards:** spike strip; retracting spikes; saw rail; dart launcher; laser gate (beam stops at solids and safety zones); swinging axe; black hole (pull with falloff and caps, blocked by solids, lethal core); tripod sniper (must sit on a stationary solid block's top face, left or right facing, fires every 2.5 s of sim time, shots pierce players and stop at blocks); cannon (floats, gravity arc, stops at first player); crossbow (floats, constant-speed straight arrows that break on the first player, shield or not); barbed wire 1/2/3 (bolts to one block edge, unsupported segments are trimmed, lethal even while wall sliding).
- **Utility:** coins (carry to the flag to bank; dropped where the carrier dies; reset to their placed spot next round); speed, jump, shield and slow-pulse stations (first collector each race, refill next race).
- **Demolition:** bombs 1×1, 2×2, 3×3. Remove every player-built object touching the area (and snipers or wire bolted to them). Never touch map terrain or map wire. Removal is permanent for the match.

Projectiles collide with every solid (L blocks use their real cells), are absorbed at safety zones, and never damage the environment. The slow pulse halves timed traps only; snipers, arrows, cannonballs and black holes are unaffected, and lasers only have their off time stretched.

## Maps

Rooftop Run, Factory Shift, Forest Heights and Frostline Ridge. Each has a protected start, a visible flag, a kill line below the map, build space everywhere, at least two route choices (for example the tower wall-climb or the fire escape on Rooftop Run) and only barbed wire as authored traps. Frostline Ridge has slippery blue ice. Map definitions are data in `shared/maps.ts`.

## Bots

Server-side bots draft, build and race through the same code paths as humans. They race by producing input bits for the same physics: they follow recorded movement primitives from the navigation graph with closed-loop steering, wait for timed hazards, take coin detours when greedy, and replan or blacklist an edge when stuck. Measured on unmodified maps (`scripts/bot-race.ts`, 6 bots per race, seeded): easy, medium and hard all finish 94–100%. On built-up courses from full bot matches, medium bots finished 19–50% of their races.

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

**Limitations.** Rooms live in memory in one process. A redeploy or restart ends every active room, and the service must run as a single replica, since there's no cross-instance room coordination. Placement validation runs on the server's main thread (about 150–250 ms typical, up to ~600 ms on a crowded course), so very busy servers will see brief hitches during build phases. Touch controls exist but desktop with keyboard or gamepad is the supported way to play. Moving platforms are treated as standing still at their start by the route check.

## Credits

All art, sound and music are original and generated in code (`client/src/art.ts`, `client/src/audio.ts`). No third-party assets.
