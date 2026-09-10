import type { CollectionName } from './serialization';

/**
 * Storage port. The repository talks only to this interface, so the durable
 * SQLite implementation and the in-memory one used by the tests behave
 * identically from the app's point of view.
 */
export interface StoredRow {
  collection: string;
  id: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  payload: string;
}

export interface DocumentStore {
  initialise(): Promise<void>;
  get(collection: CollectionName, id: string): Promise<StoredRow | null>;
  list(collection: CollectionName): Promise<StoredRow[]>;
  put(row: StoredRow): Promise<void>;
  /** Copy the current row into the backup table before it is overwritten. */
  backup(collection: CollectionName, id: string): Promise<void>;
  getBackup(collection: CollectionName, id: string): Promise<StoredRow | null>;
  remove(collection: CollectionName, id: string): Promise<void>;
  /** Media references, so a retry never deletes a file another record still uses. */
  addMediaRef(uri: string, ownerId: string, kind: string, createdAt: string): Promise<void>;
  removeMediaRefsForOwner(ownerId: string): Promise<void>;
  countMediaRefs(uri: string): Promise<number>;
  listMediaRefs(uri: string): Promise<{ ownerId: string; kind: string }[]>;
  schemaVersion(): Promise<number>;
}

/** In-memory store. Used by the tests and as the web-preview fallback. */
export class MemoryDocumentStore implements DocumentStore {
  private rows = new Map<string, StoredRow>();
  private backups = new Map<string, StoredRow>();
  private media: { uri: string; ownerId: string; kind: string; createdAt: string }[] = [];
  private version = 0;

  constructor(private readonly targetVersion: number) {}

  private key(collection: string, id: string) {
    return `${collection}::${id}`;
  }

  async initialise(): Promise<void> {
    this.version = this.targetVersion;
  }

  async get(collection: CollectionName, id: string): Promise<StoredRow | null> {
    return this.rows.get(this.key(collection, id)) ?? null;
  }

  async list(collection: CollectionName): Promise<StoredRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.collection === collection)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async put(row: StoredRow): Promise<void> {
    this.rows.set(this.key(row.collection, row.id), { ...row });
  }

  async backup(collection: CollectionName, id: string): Promise<void> {
    const existing = this.rows.get(this.key(collection, id));
    if (existing) this.backups.set(this.key(collection, id), { ...existing });
  }

  async getBackup(collection: CollectionName, id: string): Promise<StoredRow | null> {
    return this.backups.get(this.key(collection, id)) ?? null;
  }

  async remove(collection: CollectionName, id: string): Promise<void> {
    this.rows.delete(this.key(collection, id));
  }

  async addMediaRef(uri: string, ownerId: string, kind: string, createdAt: string): Promise<void> {
    const exists = this.media.some((ref) => ref.uri === uri && ref.ownerId === ownerId);
    if (!exists) this.media.push({ uri, ownerId, kind, createdAt });
  }

  async removeMediaRefsForOwner(ownerId: string): Promise<void> {
    this.media = this.media.filter((ref) => ref.ownerId !== ownerId);
  }

  async countMediaRefs(uri: string): Promise<number> {
    return this.media.filter((ref) => ref.uri === uri).length;
  }

  async listMediaRefs(uri: string): Promise<{ ownerId: string; kind: string }[]> {
    return this.media
      .filter((ref) => ref.uri === uri)
      .map((ref) => ({ ownerId: ref.ownerId, kind: ref.kind }));
  }

  async schemaVersion(): Promise<number> {
    return this.version;
  }

  /** Test helper: simulate an app restart by keeping the rows but dropping any
   * in-memory caches the repository holds. */
  snapshot(): StoredRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  /** Test helper: corrupt a stored payload to exercise backup recovery. */
  corrupt(collection: CollectionName, id: string, payload = '{not json'): void {
    const row = this.rows.get(this.key(collection, id));
    if (row) this.rows.set(this.key(collection, id), { ...row, payload });
  }
}
