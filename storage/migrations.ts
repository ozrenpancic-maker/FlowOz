/**
 * Schema migrations.
 *
 * Rules that follow from the specification: migrations are additive, they never
 * drop a document table, and every step is idempotent so an interrupted upgrade
 * can be replayed. Documents are stored as JSON text with their own
 * `schemaVersion`, which keeps a forward-incompatible record readable instead of
 * unparseable.
 */

export const SCHEMA_VERSION = 2;

export interface Migration {
  version: number;
  description: string;
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'Initial document store: settings, sites, measurements, live sessions.',
    statements: [
      `CREATE TABLE IF NOT EXISTS documents (
         collection    TEXT NOT NULL,
         id            TEXT NOT NULL,
         schema_version INTEGER NOT NULL,
         created_at    TEXT NOT NULL,
         updated_at    TEXT NOT NULL,
         payload       TEXT NOT NULL,
         PRIMARY KEY (collection, id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_documents_collection_created
         ON documents (collection, created_at DESC)`,
      // Last-committed snapshot of every document, used for backup recovery
      // when a payload is found corrupt on read.
      `CREATE TABLE IF NOT EXISTS document_backups (
         collection    TEXT NOT NULL,
         id            TEXT NOT NULL,
         schema_version INTEGER NOT NULL,
         updated_at    TEXT NOT NULL,
         payload       TEXT NOT NULL,
         PRIMARY KEY (collection, id)
       )`,
      `CREATE TABLE IF NOT EXISTS media_refs (
         uri        TEXT NOT NULL,
         owner_id   TEXT NOT NULL,
         kind       TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (uri, owner_id)
       )`,
    ],
  },
  {
    version: 2,
    description: 'Index measurements by site for the saved-measurements filter.',
    statements: [
      `CREATE TABLE IF NOT EXISTS measurement_index (
         id         TEXT PRIMARY KEY,
         site_id    TEXT,
         created_at TEXT NOT NULL,
         method     TEXT NOT NULL,
         status     TEXT NOT NULL,
         flow_m3s   REAL,
         confidence TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_measurement_index_site
         ON measurement_index (site_id, created_at DESC)`,
    ],
  },
];

export function migrationsToRun(currentVersion: number): Migration[] {
  return MIGRATIONS.filter((migration) => migration.version > currentVersion).sort(
    (a, b) => a.version - b.version
  );
}
