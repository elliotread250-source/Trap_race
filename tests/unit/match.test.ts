import { describe, expect, it } from 'vitest';
import { childRect } from '../../shared/movers';
import { MATCH, TICK_HZ, TIMERS } from '../../shared/config';
import { getItem } from '../../shared/items';
import type { ServerMsg } from '../../shared/protocol';
import { Room, type Member } from '../../server/room';

function mkRoom(mode: 'online' | 'practice' = 'online') {
  const inbox = new Map<string, ServerMsg[]>();
  const room = new Room('TEST1', mode, (id, msg) => { const a = inbox.get(id) ?? []; a.push(msg); inbox.set(id, a); }, 99);
  return { room, inbox };
}
const human = (room: Room, name: string) => { const m = room.addHuman(name, 0); if ('error' in m) throw new Error(m.error); return m as Member; };
const tickMs = (room: Room, ms: number) => { for (let i = 0; i < (ms / 1000) * TICK_HZ; i++) room.tick(); };

describe('rooms', () => {
  it('support six competitors; a seventh cannot enter as a competitor', () => {
    const { room } = mkRoom();
    human(room, 'host');
    for (let i = 0; i < 5; i++) expect('error' in room.addBot('medium')).toBe(false);
    expect(room.addBot('easy')).toEqual({ error: 'Room is full (6 players max)' });
    expect(room.addHuman('late', 0)).toEqual({ error: 'Room is full (6 players max)' });
    expect(room.members.filter(m => !m.spectator).length).toBe(MATCH.maxPlayers);
  });
  it('sanitises names and renders them as plain text', () => {
    const { room } = mkRoom();
    const m = human(room, '  <b>Evil</b>‮\u0007 name that is way too long  ');
    expect(m.name).toBe('<b>Evil</b> name'); // control and bidi characters gone, 16 chars max; HTML stays inert text
  });
  it('one human with bots is competitive; one human alone is solo practice', () => {
    const a = mkRoom(); human(a.room, 'h'); a.room.addBot('easy'); a.room.startMatch();
    expect(a.room.match!.competitive).toBe(true);
    const b = mkRoom('practice'); human(b.room, 'solo'); b.room.startMatch();
    expect(b.room.match!.competitive).toBe(false);
  });
  it('transfers host to a connected human when the host disconnects', () => {
    const { room } = mkRoom();
    const h1 = human(room, 'h1'); const h2 = human(room, 'h2');
    expect(room.hostId).toBe(h1.id);
    room.setConnected(h1.id, false);
    expect(room.hostId).toBe(h2.id);
  });
  it('lets late joiners spectate a running match without draft turns', () => {
    const { room } = mkRoom();
    human(room, 'h'); room.addBot('easy'); room.startMatch();
    const late = human(room, 'late');
    expect(late.spectator).toBe(true);
    expect(room.match!.roster.includes(late.id)).toBe(false);
    room.handle(late.id, { t: 'claim', round: 1, card: room.match!.pool[0].id });
    expect(room.match!.pool[0].by).toBeNull();
  });
});

describe('drafting', () => {
  it('offers 5-10 cards and at least one per participant', () => {
    for (const n of [1, 2, 4, 6]) {
      const { room } = mkRoom(n === 1 ? 'practice' : 'online');
      human(room, 'h');
      for (let i = 1; i < n; i++) room.addBot('medium');
      room.startMatch();
      for (let r = 0; r < 12; r++) {
        room.match!.round = r + 1;
        const pool = room.match!.makePool();
        expect(pool.length).toBeGreaterThanOrEqual(Math.max(MATCH.minPool, n));
        expect(pool.length).toBeLessThanOrEqual(MATCH.maxPool);
        expect(new Set(pool.map(c => c.id)).size).toBe(pool.length);
      }
    }
  });
  it('resolves simultaneous claims for one card to exactly one owner and grants one item per player', () => {
    const { room, inbox } = mkRoom();
    const a = human(room, 'a'), b = human(room, 'b'), c = human(room, 'c');
    room.startMatch();
    const card = room.match!.pool[0];
    room.handle(a.id, { t: 'claim', round: 1, card: card.id });
    room.handle(b.id, { t: 'claim', round: 1, card: card.id });
    expect(card.by).toBe(a.id);
    expect(inbox.get(b.id)!.some(m => m.t === 'claimFail')).toBe(true);
    // repeated / duplicate claims never grant a second item
    room.handle(a.id, { t: 'claim', round: 1, card: room.match!.pool[1].id });
    room.handle(a.id, { t: 'claim', round: 1, card: room.match!.pool[1].id });
    expect(room.match!.pool.filter(k => k.by === a.id).length).toBe(1);
    room.handle(b.id, { t: 'claim', round: 1, card: room.match!.pool[1].id });
    expect(room.match!.pool[1].by).toBe(b.id);
    // deadline assigns the rest
    tickMs(room, TIMERS.draftMs + 100);
    expect(room.match!.pool.filter(k => k.by === c.id).length).toBe(1);
    expect(room.match!.phase).toBe('build');
  });
});

describe('building and persistence', () => {
  it('accepts the first of two conflicting placements, rejects the second, and items persist into the next round', () => {
    const { room, inbox } = mkRoom();
    const a = human(room, 'a'), b = human(room, 'b');
    room.startMatch();
    const m = room.match!;
    // give both players a 1x1 block
    m.pool = [{ id: 'x1', item: 'block_1x1', by: null }, { id: 'x2', item: 'block_1x1', by: null }];
    room.handle(a.id, { t: 'claim', round: 1, card: 'x1' });
    room.handle(b.id, { t: 'claim', round: 1, card: 'x2' });
    expect(m.phase).toBe('build');
    room.handle(a.id, { t: 'place', round: 1, x: 26, y: 12, rot: 0, variant: 0 });
    room.handle(b.id, { t: 'place', round: 1, x: 26, y: 12, rot: 0, variant: 0 });
    const placedA = [...m.world.objects.values()].filter(o => o.owner === a.id);
    expect(placedA.length).toBe(1);
    expect(inbox.get(b.id)!.some(x => x.t === 'placeFail')).toBe(true);
    // a cannot place twice
    room.handle(a.id, { t: 'place', round: 1, x: 27, y: 12, rot: 0, variant: 0 });
    expect([...m.world.objects.values()].filter(o => o.owner === a.id).length).toBe(1);
    room.handle(b.id, { t: 'place', round: 1, x: 28, y: 12, rot: 0, variant: 0 });
    expect(m.phase).toBe('countdown');
    // stale input from another round is ignored
    room.handle(a.id, { t: 'in', round: 0, s: 1, b: [2, 2, 2] });
    tickMs(room, TIMERS.countdownMs + 50);
    expect(m.phase).toBe('race');
    tickMs(room, TIMERS.raceMs + TIMERS.resultsMs + 500);
    expect(m.round).toBe(2);
    expect(m.phase).toBe('draft');
    expect([...m.world.objects.values()].filter(o => o.prov === 'player').length).toBe(2);
    // a brand new match starts from the clean map
    room.startMatch();
    expect([...room.match!.world.objects.values()].filter(o => o.prov === 'player').length).toBe(0);
  });

  it('rejects rotation for snipers and black holes over the network as well', () => {
    const { room, inbox } = mkRoom();
    const a = human(room, 'a'); room.addBot('easy');
    room.startMatch();
    const m = room.match!;
    m.pool = [{ id: 'bh', item: 'blackhole', by: null }, { id: 'z', item: 'coin', by: null }];
    room.handle(a.id, { t: 'claim', round: 1, card: 'bh' });
    tickMs(room, TIMERS.draftMs + 50);
    room.handle(a.id, { t: 'place', round: 1, x: 26, y: 10, rot: 1, variant: 0 });
    expect(inbox.get(a.id)!.some(x => x.t === 'placeFail' && /rotated/.test(x.msg))).toBe(true);
  });
});

describe('a full match with bots', () => {
  it('drafts, builds, races and scores every round and ends with a winner', () => {
    const { room, inbox } = mkRoom();
    const h = human(room, 'host');
    room.rounds = 3;
    room.addBot('medium'); room.addBot('hard'); room.addBot('easy');
    room.startMatch();
    let guard = 0;
    while (room.phase !== 'matchEnd' && guard++ < TICK_HZ * 60 * 12) room.tick();
    expect(room.phase).toBe('matchEnd');
    const m = room.match!;
    expect(m.results.length).toBe(3);
    const msgs = inbox.get(h.id)!;
    expect(msgs.some(x => x.t === 'matchEnd')).toBe(true);
    // bots appear in results and at least one bot finished at least once
    const botIds = room.members.filter(x => x.bot).map(x => x.id);
    expect(m.results.flat().some(r => botIds.includes(r.pid) && r.time !== null)).toBe(true);
    // every placed object came through the draft
    for (const o of m.world.objects.values()) if (o.prov === 'player') expect(getItem(o.item)).toBeTruthy();
  });
});

describe('large maps with six players', () => {
  it('six players (five bots) bridge The Great Oak, race several rounds and finish the match; moving items persist and replay from GO', () => {
    const { room } = mkRoom();
    human(room, 'host'); // rooms with no connected human close themselves
    room.mapId = 'oak';
    room.rounds = 4;
    for (let i = 0; i < 5; i++) room.addBot(i % 3 === 0 ? 'hard' : 'medium');
    room.startMatch();
    const m = room.match!;
    // seed every draft with the two moving items so they accumulate across rounds
    let seededRound = 0, opened = -1, scoutRaces = 0;
    let guard = 0;
    while (room.phase !== 'matchEnd' && guard++ < TICK_HZ * 60 * 20) {
      if (m.phase === 'draft' && seededRound !== m.round) {
        seededRound = m.round;
        m.pool[0].item = 'shuttle'; m.pool[1].item = 'wheel';
      }
      if (m.phase === 'race' && m.race && m.race.tick === 1) {
        if (!m.courseOpen) scoutRaces++;
        else if (opened < 0) opened = m.round;
        // every race starts every moving platform at its GO pose
        for (const mv of m.race.movers) if (!mv.hz) expect(mv.prev).toEqual(childRect(mv.o, mv.child, 0));
      }
      room.tick();
    }
    expect(room.phase).toBe('matchEnd');
    expect(m.results.length).toBe(4);
    expect(opened).toBeGreaterThan(0); // bots built the crossing
    expect(opened).toBeLessThanOrEqual(2);
    expect(m.results.flat().some(r => r.time !== null)).toBe(true);
    expect(scoutRaces).toBeLessThanOrEqual(1);
    // scores add up and no hidden bonus appeared
    for (const [pid, t] of m.tally) expect(t.score).toBe(m.results.flat().filter(r => r.pid === pid).reduce((a, r) => a + r.total, 0));
    expect(m.stats.maxValidationMs).toBeLessThan(4000);
  }, 240000);
});
