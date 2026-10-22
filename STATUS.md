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

## Implemented, verified by hand or by benchmark only
- Bot completion rates (`scripts/bot-race.ts`, `scripts/bot-bench.ts`), numbers in README
- Rendering of all items, skins, effects and the build preview (screenshots during development)
- Touch controls (rendered and wired; not tested on a physical device)
- Audio (synthesised; can't be heard in headless runs)
- Gamepad input (code path only; no gamepad available)

## Known limitations
See README "Limitations".

## Commands
`npm test`, `npm run typecheck`, `npm run build`, `npm run e2e`.

## Deployment
- Railway project "arcade", service `trap-race` (single replica, Dockerfile build, healthcheck `/healthz`), deploys from this repo's `claude/compassionate-ramanujan-hqs0jy` branch.
- Game URL: https://trap-race-production.up.railway.app
- Open Arcade card: registry entry `trap-race` in `elliotread250-source/Blackjack` (`arcade/`, branch `claude/awesome-heisenberg-qcknm3`, which the hub service deploys).
- Hub rollback point before this release: deployment `1b5b5245-17fe-4857-9956-fc4eed04cea8` (commit `d73ded5`).
- Not verified from the build environment: live browser play against production. The build sandbox's network policy blocks `*.up.railway.app`. Railway reported the deployment healthy (its `/healthz` check passed). Manual check: open the arcade, find Trap Race, Play, Create Room in one browser and Join by code in another, then run one round; also try Play Against AI.
