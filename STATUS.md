# Implementation status

## Implemented and tested (automated)
- Exact block, plank and L shapes, all rotations, L interior empty (`tests/unit/items-placement.test.ts`)
- Rotation for every item except sniper and black hole; server rejects rotation for both
- Grid-only placement, off-grid rejection, no overlap for any footprint incl. coins and traps, safety zones
- Route-blocking rejection using physics probes; same-wall wall climb of a 12-cell wall
- Sniper support rules (air, wall side, ceiling, non-solid, moving supports rejected)
- Barbed wire on all four edges, trimming 3→1 and 3→2, no corner wrap or bridging, overlap rejection
- Bombs: exact footprints, whole-object removal, dependents removed, map terrain and map wire untouched, "No removable items"
- Maps: four maps, only barbed wire authored, all reachable (also `scripts/map-ascii.ts`)
- Wall slide cap, no slide while rising, wall jump direction, no repeat while holding, identical hitboxes
- Sniper cadence 150/300/450… ticks, piercing, block stops shots, no tunnelling through a 1-cell block
- Cannon gravity arc, crossbow constant speed, arrow breaks on shielded player
- Black hole pull, lethal core, owner credit, solid occlusion, protected zones ignore pull
- Coins: pickup awards nothing, exact death-spot drop, rebanking by another player, origin reset, single carrier, lost on falls
- Scoring examples, tied first finishers, solo practice without bonuses, trap cap, duplicates ignored, tie-breaks
- Same-tick lethal beats finish; disconnect clears inputs and eliminates after 20 s; determinism
- Rooms: 6-player cap, name sanitising, competitive vs practice, host transfer, late joiners spectate
- Draft: pool 5–10 and ≥ participants, simultaneous claims → one owner, one item each, timeout assignment
- Build: conflicting placements, one placement per player, stale inputs ignored, persistence across rounds, clean map per match
- Full 3-round match with bots ends with results and a winner (`tests/unit/match.test.ts`)
- Network: real server + two WebSocket clients: version and bad-code errors, exclusive claim, host-only actions, reconnect with the same identity, server-authoritative movement (`tests/unit/network.test.ts`)
- Browser: two independent Chromium contexts create/join by invite link, draft, build, race, identical results, persistence, refresh restores identity, human vs bots, solo practice, arcade link, no page errors, ~60 fps headless (`tests/e2e/run.mjs`)

- Mobile (Chromium emulation, `tests/e2e/mobile.mjs`): portrait rotate prompt; phone landscape and tablet: tap/drag aiming, Place button, on-screen controls with multi-touch run + jump

## Map and moving-platform update (Oct 2026), automated
- `tests/unit/movers.test.ts`: exact 2×1/1×2 bodies, lanes follow rotation, smooth repeated reversal, riders carried exactly (no drift, no boosts), jump off and land again, never pushed through walls; four gondolas 90° apart at the radius, never touching, phase-locked over 1,000,000 ticks, non-collidable pivot and centre, laps with a rider without jitter; lane reservation and conflicts, headroom, no attachments; projectiles hit bodies with relative motion, pass the pivot; bombs remove the whole wheel and its lane.
- `tests/unit/maps.test.ts`: large maps ≥1.5× wider; flags at the far end; only wire authored; old Rooftop plank skip gone; left-wall shafts give no whole-map skip on any map; mountain rock continuous and fused to the sky (air-connectivity proof); Oak uncrossable without building, opened by Plank 5/7, Spring, Shuttle lift or two small blocks; partial building accepted, cut-offs rejected, spawn and terrain rules kept; bots cross mover-only pits.
- `tests/unit/match.test.ts`: six players (five bots) on the Oak for four rounds with shuttles and wheels in every draft: bots bridge the tree by round 2, movers reset to their GO pose every race, tallies match round rows.
- `tests/e2e/movers.mjs` (two Chromium contexts on Under the Mountain, 14 checks): both cards in the draft, lane-into-rock rejected, shuttle and wheel placed through the server, identical motion definitions and reserved lanes, identical poses at 30 shared ticks, reload mid-race keeps identity, items and phase, bomb on the pivot removes the wheel everywhere, next race has only the shuttle.
- Existing suites still pass: `npm test` (76 tests), `tests/e2e/run.mjs` (12/12), `tests/e2e/mobile.mjs` (now skips bomb cards on an empty first course, which could make it flaky).

## Gameplay update (Oct 23 2026), automated
- `tests/unit/update.test.ts` (30 tests): wheel accepted with one valid gondola and three overlapping blocks (all four orbit), rejected with none, orbit kept on the map and out of safety zones, preview and server decide identically; wheel centre non-solid, axe pivot solid 1x1 you can stand on; shuttle starts partly in a wall and slides through, wholly-embedded rejected; 3x1 platform runs its full 6 cells through a wall; travel 2x1 3->6 cells, 3x1 4->6 cells, speed kept; horizontal pin and vertical lift crushes kill once with owner credit (0.2), self-crush credits nobody, standing at a wall or riding into one is safe, shields don't help; retracting spikes have a solid base and only kill when out; spiky oval 3x1/1x3 with an elliptical lethal area; no dart shooter, legacy worlds migrate without crashing; crumbles: one landing survives, second breaks, long standing counts once, one wall slide counts once, one hit per shot and a breaking shot still stops, broken until next round, bombed stays gone; black holes: stronger, a sideways approach swings ~120 degrees and leaves alive, a direct one dies, stable with three holes, never pulls through a wall; arrows bend and are absorbed; instant sniper shots bend in the firing tick and stay bounded; banked coins spent through resets and snapshots; human-first draft (bots refused until humans pick, timeouts and disconnects auto-picked first); score target 5..15 validated and locked; trap kill crossing the target ends the match mid-race exactly once; same-tick crossings share the win; no early sole bonus; sealing placement accepted, race ends, bomb offered and reopens.
- `tests/unit/rider.test.ts` (7 tests): server sim + client predictor over a lagged, jittery link at 30/60/144 fps; riders stay glued to the drawn gondola for whole orbits, jumps land back cleanly, and a late duplicated snapshot no longer rewinds the rider (this case failed before the fix).
- Existing suites updated to the new rules; `npm test` 113/113, `npm run typecheck`, `npm run build` clean.
- Browser (local production build): `tests/e2e/run.mjs` 12/12, `tests/e2e/movers.mjs` 15/15, `tests/e2e/mobile.mjs` pass, `tests/e2e/update.mjs` 8/8 (score target options and server rejection, "Players choosing" with no bot picks, AI picks leftovers after the human, wheel preview with partial gondolas, item art screenshots).
- Load: `scripts/profile-load.ts`: six-player race with 18 moving bodies, holes, crossbows, snipers and bots: 0.15-0.36 ms p95 per tick, ~1.8 KB snapshots (~35 KB/s per client).

## Implemented, verified by hand or by benchmark only
- Physical phones and tablets (only emulated so far; iOS Safari cannot lock orientation or go fullscreen, so it relies on the rotate prompt)
- Bot completion rates (`scripts/bot-race.ts`, `scripts/bot-bench.ts`), numbers in README
- Rendering of all items, skins, effects and the build preview (screenshots during development)
- Audio (synthesised; can't be heard in headless runs)
- Gamepad input (code path only; no gamepad available)

## Known limitations
See README "Limitations".

## Commands
`npm test`, `npm run typecheck`, `npm run build`, `npm run e2e`.

## Deployment
- Railway project "arcade", service `trap-race` (single replica, Dockerfile build, healthcheck `/healthz`). Since Oct 23 2026 it auto-deploys from `claude/new-session-dmauqj` and runs in EU West (Amsterdam, `europe-west4-drams3a`); before that it deployed `claude/compassionate-ramanujan-hqs0jy` from US West (`sfo`). Rollback point: deployment `88634649-a5cd-43c4-ad4b-7ccc724bdb02` (commit `5010c85`, region sfo).
- Game URL: https://trap-race-production.up.railway.app (unchanged, so the Open Arcade card needs no change)
- Open Arcade card: registry entry `trap-race` in `elliotread250-source/Blackjack` (`arcade/`, branch `claude/awesome-heisenberg-qcknm3`, which the hub service deploys).
- Oct 2026 map and moving-platform release: commit `1d40176`, deployment `82d68d44-f2ee-463c-b4b3-ae829f53c7b0`, status SUCCESS; runtime log "route graphs ready for 6 maps in 1020 ms". Rollback point: deployment `4e0431f1-7035-4673-bb3d-3711cc048804` (commit `ac1d602`).
- Oct 23 2026 gameplay update: commit `b359ce6`, deployment `88838d43-8fb0-4923-8bdd-094c13c86a19`, status SUCCESS in `europe-west4-drams3a`, runtime log "route graphs ready for 6 maps in 717 ms". The hub service was not touched (deployment `3cabd713`, SUCCESS). Live play and real-player ping were not measurable from the build sandbox (proxy 403 on `*.up.railway.app`).
- Not verified from the build environment: live browser play against production. The sandbox's network policy blocks `*.up.railway.app` (proxy 403), so the new maps, the two item cards and two-client play were verified only against a local production build (`tests/e2e/movers.mjs`, `tests/e2e/run.mjs`). Manual check: open the arcade, launch Trap Race, Create Room, pick The Great Oak or Under the Mountain, join from a second browser, look for the Shuttle Block and Ferris Wheel cards, run a round; then launch one other arcade game.
