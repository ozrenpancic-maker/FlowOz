import * as SQLite from 'expo-sqlite';

import type { DocumentStore, StoredRow } from './document-store';
import { MIGRATIONS, SCHEMA_VERSION, migrationsToRun } from './migrations';
import type { CollectionName } from './serialization';

/**
 * Durable store backed by expo-sqlite.
 *
 * Everything is awaited and the repository above serialises the writes, so a
 * React state update only ever follows a committed row.
 */
export const DATABASE_NAME = 'flowvision.db';

export class SqliteDocumentStore implements DocumentStore {
  private database: SQLite.SQLiteDatabase | null = null;

  private db(): SQLite.SQLiteDatabase {
    if (!this.database) throw new Error('Database used before initialise()');
    return this.database;
  }

  async initialise(): Promise<void> {
    if (this.database) return;
    const database = await SQLite.openDatabaseAsync(DATABASE_NAME);
    // WAL keeps a field save durable without blocking the UI thread's reads.
    await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database = database;

    const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const current = row?.user_version ?? 0;

    for (const migration of migrationsToRun(current)) {
      await database.withTransactionAsync(async () => {
        for (const statement of migration.statements) {
          await database.execAsync(statement);
        }
      });
      // PRAGMA does not accept a bound parameter; the value is a literal from
      // our own migration table, never operator input.
      await database.execAsync(`PRAGMA user_version = ${migration.version}`);
    }

    if (migrationsToRun(current).length === 0 && current === 0 && MIGRATIONS.length > 0) {
      await database.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  async schemaVersion(): Promise<number> {
    const row = await this.db().getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    return row?.user_version ?? 0;
  }

  async get(collection: CollectionName, id: string): Promise<StoredRow | null> {
    const row = await this.db().getFirstAsync<RawRow>(
      'SELECT collection, id, schema_version, created_at, updated_at, payload FROM documents WHERE collection = ? AND id = ?',
      [collection, id]
    );
    return row ? mapRow(row) : null;
  }

  async list(collection: CollectionName): Promise<StoredRow[]> {
    const rows = await this.db().getAllAsync<RawRow>(
      'SELECT collection, id, schema_version, created_at, updated_at, payload FROM documents WHERE collection = ? ORDER BY created_at DESC',
      [collection]
    );
    return rows.map(mapRow);
  }

  async put(row: StoredRow): Promise<void> {
    await this.db().runAsync(
      `INSERT INTO documents (collection, id, schema_version, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET
         schema_version = excluded.schema_version,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
      [row.collection, row.id, row.schemaVersion, row.createdAt, row.updatedAt, row.payload]
    );
  }

  async backup(collection: CollectionName, id: string): Promise<void> {
    await this.db().runAsync(
      `INSERT INTO document_backups (collection, id, schema_version, updated_at, payload)
       SELECT collection, id, schema_version, updated_at, payload FROM documents
       WHERE collection = ? AND id = ?
       ON CONFLICT(collection, id) DO UPDATE SET
         schema_version = excluded.schema_version,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
      [collection, id]
    );
  }

  async getBackup(collection: CollectionName, id: string): Promise<StoredRow | null> {
    const row = await this.db().getFirstAsync<RawRow>(
      'SELECT collection, id, schema_version, updated_at, updated_at AS created_at, payload FROM document_backups WHERE collection = ? AND id = ?',
      [collection, id]
    );
    return row ? mapRow(row) : null;
  }

  async remove(collection: CollectionName, id: string): Promise<void> {
    await this.db().runAsync('DELETE FROM documents WHERE collection = ? AND id = ?', [
      collection,
      id,
    ]);
  }

  async addMediaRef(uri: string, ownerId: string, kind: string, createdAt: string): Promise<void> {
    await this.db().runAsync(
      `INSERT INTO media_refs (uri, owner_id, kind, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(uri, owner_id) DO UPDATE SET kind = excluded.kind`,
      [uri, ownerId, kind, createdAt]
    );
  }

  async removeMediaRefsForOwner(ownerId: string): Promise<void> {
    await this.db().runAsync('DELETE FROM media_refs WHERE owner_id = ?', [ownerId]);
  }

  async countMediaRefs(uri: string): Promise<number> {
    const row = await this.db().getFirstAsync<{ total: number }>(
      'SELECT COUNT(*) AS total FROM media_refs WHERE uri = ?',
      [uri]
    );
    return row?.total ?? 0;
  }

  async listMediaRefs(uri: string): Promise<{ ownerId: string; kind: string }[]> {
    const rows = await this.db().getAllAsync<{ owner_id: string; kind: string }>(
      'SELECT owner_id, kind FROM media_refs WHERE uri = ?',
      [uri]
    );
    return rows.map((row) => ({ ownerId: row.owner_id, kind: row.kind }));
  }
}

interface RawRow {
  collection: string;
  id: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
  payload: string;
}

function mapRow(row: RawRow): StoredRow {
  return {
    collection: row.collection,
    id: row.id,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    payload: row.payload,
  };
}
