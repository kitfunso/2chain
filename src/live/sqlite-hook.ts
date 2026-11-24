import type Database from 'better-sqlite3';
import type { ChangeEvent } from '../types.js';

const MAX_QUEUE = 1000;

type Op = 'insert' | 'update' | 'delete';
interface RawEvent {
  op: Op;
  table: ChangeEvent['table'];
  rowid: bigint;
}

export class SqliteChangeHook {
  private queue: RawEvent[] = [];
  private listeners: Array<(e: ChangeEvent) => void> = [];
  private draining = false;
  private dropped = 0;

  install(db: Database.Database): void {
    db.function('notify_change', { deterministic: false }, (
      op: unknown,
      table: unknown,
      rowid: unknown,
    ) => {
      this.enqueue(String(op) as Op, String(table) as ChangeEvent['table'], BigInt(rowid as number));
      return null;
    });

    db.exec(`
      -- Notification triggers — fire AFTER mutations on each watched table.
      -- The notify_change() function pushes to the JS queue; an async drain
      -- worker dispatches to SSE-aware listeners.

      CREATE TRIGGER IF NOT EXISTS tools_notify_ai AFTER INSERT ON tools BEGIN
        SELECT notify_change('insert', 'tools', new.rowid);
      END;
      CREATE TRIGGER IF NOT EXISTS tools_notify_au AFTER UPDATE ON tools BEGIN
        SELECT notify_change('update', 'tools', new.rowid);
      END;
      CREATE TRIGGER IF NOT EXISTS tools_notify_ad AFTER DELETE ON tools BEGIN
        SELECT notify_change('delete', 'tools', old.rowid);
      END;

      CREATE TRIGGER IF NOT EXISTS usage_notify_ai AFTER INSERT ON usage BEGIN
        SELECT notify_change('insert', 'usage', new.rowid);
      END;
      CREATE TRIGGER IF NOT EXISTS violations_notify_ai AFTER INSERT ON violations BEGIN
        SELECT notify_change('insert', 'violations', new.rowid);
      END;
      CREATE TRIGGER IF NOT EXISTS eval_runs_notify_ai AFTER INSERT ON eval_runs BEGIN
        SELECT notify_change('insert', 'eval_runs', new.rowid);
      END;
      CREATE TRIGGER IF NOT EXISTS rankings_notify_ai AFTER INSERT ON rankings BEGIN
        SELECT notify_change('insert', 'rankings', new.rowid);
      END;
    `);
  }

  addListener(fn: (e: ChangeEvent) => void): void {
    this.listeners.push(fn);
  }

  get droppedCount(): number {
    return this.dropped;
  }

  flush(): void {
    this.drain();
  }

  private enqueue(op: Op, table: ChangeEvent['table'], rowid: bigint): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push({ op, table, rowid });
    if (!this.draining) {
      setImmediate(() => this.drain());
    }
  }

  private drain(): void {
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const raw = this.queue.shift()!;
        const event: ChangeEvent = {
          type: rawToEventType(raw.op, raw.table),
          table: raw.table,
          rowid: raw.rowid,
        };
        for (const fn of this.listeners) {
          try {
            fn(event);
          } catch (err) {
            console.error('SqliteChangeHook listener error:', err);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

function rawToEventType(op: Op, table: ChangeEvent['table']): ChangeEvent['type'] {
  if (table === 'tools') return 'tool_changed';
  if (table === 'usage') return 'tool_invoked';
  if (table === 'violations') return 'violation_logged';
  if (table === 'eval_runs') return 'eval_completed';
  if (table === 'rankings') return 'discover_ran';
  return 'tool_changed';
}
