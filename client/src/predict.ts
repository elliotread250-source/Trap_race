// Local-player prediction and reconciliation, free of DOM and network code so it can be tested against a real server sim.
import { DT, PHYS } from '../../shared/config';
import { moverRect } from '../../shared/hazards';
import { newBody, stepBody, type Body } from '../../shared/physics';
import { applyBodySnap, type PlayerSnap, type RaceSim, type RaceSnapshot, type SimMover } from '../../shared/race';

/**
 * The server runs input seq s on tick base.tick + (s - base.ack), where base is the latest snapshot's tick and our
 * acknowledged input. Every unacknowledged input is replayed against the platform poses of exactly that tick.
 */
export class Predictor {
  readonly race: RaceSim;
  readonly you: string;
  pred: Body | null = null;
  pending: { seq: number; b: number }[] = [];
  seq = 0;
  predBase = { tick: 0, ack: 0 };
  /** visual-only offset that eases out a reconciliation correction; never fed back into the simulation */
  corr = { x: 0, y: 0 };
  /** tick of the newest snapshot applied: older or repeated snapshots are ignored, so prediction never rewinds */
  lastSnapTick = -1;
  stats = { lastCorr: 0, predSteps: 0, stale: 0 };
  private sendBuf: { seq: number; b: number }[] = [];

  constructor(race: RaceSim, you: string) {
    this.race = race;
    this.you = you;
  }

  tickForSeq(seq: number): number { return this.predBase.tick + (seq - this.predBase.ack); }

  /** Platforms for one input: kinematic bodies at its exact server tick, legacy moving platforms at the mirrored phase. */
  predMovers(tick: number) {
    const race = this.race;
    const slow = race.slowTicks > 0 ? 0.5 : 1;
    return race.moversAt(tick, (m: SimMover) => ({ rect: moverRect(m.o, m.hz!.phase, m.hz!.pathLen), prev: moverRect(m.o, m.hz!.phase - DT * slow, m.hz!.pathLen) }));
  }

  /** Returns false for a snapshot that is not newer than the last one (it must not rewind the prediction). */
  accept(s: RaceSnapshot): boolean {
    if (s.tick <= this.lastSnapTick) { this.stats.stale++; return false; }
    this.lastSnapTick = s.tick;
    return true;
  }

  /** Rebase on the server's state for our player and replay what it has not processed yet. */
  reconcile(s: RaceSnapshot, me: PlayerSnap) {
    this.predBase = { tick: s.tick, ack: me.ack };
    if (me.st !== 'racing') { this.pred = null; this.pending = []; return; }
    if (!this.pred) this.pred = newBody(me.x, me.y);
    const before = { x: this.pred.x, y: this.pred.y };
    applyBodySnap(this.pred, me);
    this.pending = this.pending.filter(p => p.seq > me.ack);
    const p = this.race.player(this.you)!;
    for (const pi of this.pending) { stepBody(this.pred, pi.b, this.race.envFor(p, this.predMovers(this.tickForSeq(pi.seq)))); this.stats.predSteps++; }
    const dx = before.x - this.pred.x, dy = before.y - this.pred.y;
    this.stats.lastCorr = Math.hypot(dx, dy);
    if (this.pred.grounded && this.pred.groundMover >= 0) {
      // A rider's position is defined by the platform under them, and the platform is drawn at its exact pose. Easing a
      // correction out here would draw the rider floating beside or sinking into a moving gondola, so it snaps instead.
      this.corr.x = 0; this.corr.y = 0;
    } else if (Math.hypot(dx, dy) < 64) { this.corr.x += dx; this.corr.y += dy; } // small corrections are smoothed visually
    else { this.corr.x = 0; this.corr.y = 0; } // big ones snap
  }

  /** One local fixed tick with the given input bits. */
  step(bits: number) {
    const p = this.race.player(this.you);
    if (!p || !this.pred) return;
    this.seq++;
    this.pending.push({ seq: this.seq, b: bits });
    if (this.pending.length > 240) this.pending.shift();
    this.sendBuf.push({ seq: this.seq, b: bits });
    stepBody(this.pred, bits, this.race.envFor(p, this.predMovers(this.tickForSeq(this.seq))));
    if (this.pred.grounded && this.pred.groundMover >= 0) { this.corr.x = 0; this.corr.y = 0; }
  }

  /** Inputs to send now (sent every frame, so an input never waits for a slow UI timer). */
  takeBatch(force: boolean): { s: number; b: number[] } | null {
    if (!this.sendBuf.length || (!force && this.sendBuf.length < 2)) return null;
    const out = { s: this.sendBuf[0].seq, b: this.sendBuf.map(x => x.b) };
    this.sendBuf = [];
    return out;
  }

  decay(dtMs: number) {
    const k = Math.pow(0.0001, dtMs / 1000);
    this.corr.x *= k; this.corr.y *= k;
  }

  /** Where the local player is drawn. */
  drawn(): { x: number; y: number } | null { return this.pred ? { x: this.pred.x + this.corr.x, y: this.pred.y + this.corr.y } : null; }
}

export const BODY_H = PHYS.bodyH;
