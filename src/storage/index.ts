// Storage factory. Reads STORAGE_DRIVER env, returns the concrete impl.
// Implementations land in subsequent steps:
//   sqlite   -> Step 4 (Phase 1)
//   postgres -> Phase 2

import type { Storage } from '../types.js';

export type StorageDriver = 'sqlite' | 'postgres' | 'mongodb';

export function getStorageDriver(): StorageDriver {
  const v = (process.env.STORAGE_DRIVER ?? 'mongodb').toLowerCase();
  if (v === 'sqlite' || v === 'postgres' || v === 'mongodb') return v;
  throw new Error(`STORAGE_DRIVER must be sqlite|postgres|mongodb, got: ${v}`);
}

export async function createStorage(): Promise<Storage> {
  const driver = getStorageDriver();
  switch (driver) {
    case 'sqlite': {
      // Lazy import so non-sqlite deployments don't pay the better-sqlite3 load cost.
      throw new Error(
        'SqliteStorage not yet implemented (Phase 1 Step 4). Set STORAGE_DRIVER=mongodb during transition.',
      );
    }
    case 'postgres':
      throw new Error('PostgresStorage not yet implemented (Phase 2).');
    case 'mongodb':
      throw new Error(
        'MongoDB storage is the legacy v1 path. v2 routes use SqliteStorage; keep STORAGE_DRIVER=mongodb only for v1 transition runs.',
      );
  }
}

export type { Storage } from '../types.js';
