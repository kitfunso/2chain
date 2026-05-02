// Storage factory. Reads STORAGE_DRIVER env, returns the concrete impl.
//   sqlite   -> SqliteStorage (Phase 1, default for personal tier)
//   postgres -> Phase 2
//   mongodb  -> v1 legacy (no longer wired into v2 routes)

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Storage } from '../types.js';

export type StorageDriver = 'sqlite' | 'postgres' | 'mongodb';

export function getStorageDriver(): StorageDriver {
  const v = (process.env.STORAGE_DRIVER ?? 'sqlite').toLowerCase();
  if (v === 'sqlite' || v === 'postgres' || v === 'mongodb') return v;
  throw new Error(`STORAGE_DRIVER must be sqlite|postgres|mongodb, got: ${v}`);
}

export async function createStorage(): Promise<Storage> {
  const driver = getStorageDriver();
  switch (driver) {
    case 'sqlite': {
      // Lazy import so non-sqlite deployments don't pay the better-sqlite3 load cost.
      const { SqliteStorage } = await import('./sqlite.js');
      const path = resolve(
        process.env.TWOCHAIN_DB_PATH ?? `${homedir()}/.2chain/db.sqlite`,
      );
      return new SqliteStorage({ path });
    }
    case 'postgres':
      throw new Error('PostgresStorage not yet implemented (Phase 2).');
    case 'mongodb':
      throw new Error(
        'MongoDB storage is the legacy v1 path. v2 routes use SqliteStorage; ' +
          'set STORAGE_DRIVER=sqlite (the default).',
      );
  }
}

export type { Storage } from '../types.js';
