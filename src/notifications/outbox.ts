import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeResultSignal, resultSignalSchema, NOTIFICATION_TTL_MS } from './signal.ts';
import type { ResultSignal } from './signal.ts';

/** IDs only. A query receipt and firmware playback completion are both required. */
export class NotificationOutbox {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS signals (
        event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL,
        last_sent INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
        queried_for TEXT, queried_at INTEGER NOT NULL DEFAULT 0
      )`);
    const columns = this.db.prepare('PRAGMA table_info(signals)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'queried_for')) {
      // Old wake ACKs did not prove a query or playback: recover them as pending.
      this.db.exec('ALTER TABLE signals ADD COLUMN queried_for TEXT; ALTER TABLE signals ADD COLUMN queried_at INTEGER NOT NULL DEFAULT 0');
      const rows = this.db.prepare('SELECT event_id,payload FROM signals').all() as {event_id: string; payload: string}[];
      for (const row of rows) {
        const signal = resultSignalSchema.parse(JSON.parse(row.payload));
        signal.expires_at += NOTIFICATION_TTL_MS - 900_000;
        this.db.prepare('UPDATE signals SET payload=?,expires_at=?,done=0,last_sent=0 WHERE event_id=?')
          .run(JSON.stringify(signal), signal.expires_at, row.event_id);
      }
    }
  }
  discover(namespace: string, taskId: string, finishedAt: number, now = Date.now()): void {
    const signal = makeResultSignal(namespace, taskId, finishedAt);
    if (signal.expires_at <= now) return;
    this.db.prepare('INSERT OR IGNORE INTO signals(event_id,payload,expires_at) VALUES (?,?,?)')
      .run(signal.event_id, JSON.stringify(signal), signal.expires_at);
  }
  due(now = Date.now()): ResultSignal[] {
    // One outstanding trigger; backlog is queried as a frozen, merged batch.
    const row = this.db.prepare('SELECT payload,last_sent FROM signals WHERE done=0 AND expires_at>? ORDER BY expires_at,event_id LIMIT 1')
      .get(now) as {payload: string; last_sent: number} | undefined;
    return row && row.last_sent <= now - 15_000 ? [resultSignalSchema.parse(JSON.parse(row.payload))] : [];
  }
  sent(eventId: string, now = Date.now()): void {
    this.db.prepare('UPDATE signals SET last_sent=? WHERE event_id=?').run(now, eventId);
  }
  queryBatch(now = Date.now()): ResultSignal[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const first = this.db.prepare('SELECT event_id,last_sent FROM signals WHERE done=0 AND expires_at>? ORDER BY expires_at,event_id LIMIT 1')
        .get(now) as {event_id: string; last_sent: number} | undefined;
      if (!first || !first.last_sent) { this.db.exec('COMMIT'); return []; }
      let rows = this.db.prepare('SELECT payload FROM signals WHERE done=0 AND expires_at>? AND queried_for=? ORDER BY expires_at,event_id')
        .all(now, first.event_id) as {payload: string}[];
      if (!rows.length) {
        rows = this.db.prepare('SELECT payload FROM signals WHERE done=0 AND expires_at>? ORDER BY expires_at,event_id LIMIT 20').all(now) as {payload: string}[];
        for (const row of rows) {
          const signal = resultSignalSchema.parse(JSON.parse(row.payload));
          this.db.prepare('UPDATE signals SET queried_for=?,queried_at=? WHERE event_id=?').run(first.event_id, now, signal.event_id);
        }
      }
      this.db.prepare('UPDATE signals SET queried_at=? WHERE done=0 AND queried_for=?').run(now, first.event_id);
      this.db.exec('COMMIT');
      return rows.map((r) => resultSignalSchema.parse(JSON.parse(r.payload)));
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  acknowledge(eventId: string, receiver: string, stage: string): boolean {
    if (receiver !== 'firmware') return false;
    if (stage === 'query_started') {
      this.sent(eventId, Date.now() + 180_000);
      this.db.prepare('UPDATE signals SET queried_at=0 WHERE done=0 AND queried_for=?').run(eventId);
      return false;
    }
    if (stage !== 'playback_completed') return false;
    return this.db.prepare('UPDATE signals SET done=1 WHERE done=0 AND queried_for=? AND queried_at>0').run(eventId).changes > 0;
  }
  queryServed(now = Date.now()): ResultSignal[] {
    const row = this.db.prepare('SELECT payload,queried_at,queried_for,event_id FROM signals WHERE done=0 AND expires_at>? ORDER BY expires_at,event_id LIMIT 1')
      .get(now) as {payload: string; queried_at: number; queried_for: string; event_id: string} | undefined;
    return row && row.queried_at > 0 && row.queried_for === row.event_id ? [resultSignalSchema.parse(JSON.parse(row.payload))] : [];
  }
  clearable(now = Date.now()): string[] {
    return (this.db.prepare('SELECT event_id FROM signals WHERE done!=2 AND (done=1 OR expires_at<=?)').all(now) as {event_id: string}[])
      .map((r) => r.event_id);
  }
  cleared(eventId: string): void { this.db.prepare('UPDATE signals SET done=2 WHERE event_id=?').run(eventId); }
  prune(now = Date.now()): void { this.db.prepare('DELETE FROM signals WHERE done=2 AND expires_at<?').run(now - NOTIFICATION_TTL_MS); }
  close(): void { this.db.close(); }
}
