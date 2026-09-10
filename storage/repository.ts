import type { SavedMeasurement } from '../domain/measurement';
import type { Site } from '../domain/types';
import type { DocumentStore, StoredRow } from './document-store';
import { SCHEMA_VERSION } from './migrations';
import {
  COLLECTIONS,
  deserialise,
  isSavedMeasurement,
  isSite,
  serialise,
  type CollectionName,
} from './serialization';
import type { AppSettings } from './settings';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';

/**
 * Versioned local repository.
 *
 * Writes are queued so that two screens can never interleave a save; each write
 * backs up the last committed payload first, so a corrupt row can be recovered
 * instead of losing a field measurement. Nothing leaves the device.
 */

export type RepositoryErrorCode =
  | 'NOT_INITIALISED'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'CORRUPT_DOCUMENT'
  | 'NOT_FOUND';

export class RepositoryError extends Error {
  constructor(
    readonly code: RepositoryErrorCode,
    message: string,
    readonly detail?: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

const SETTINGS_ID = 'app';

export class Repository {
  private ready = false;
  /** Serialises every write: each save awaits the previous one. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: DocumentStore) {}

  async initialise(): Promise<void> {
    if (this.ready) return;
    await this.store.initialise();
    this.ready = true;
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new RepositoryError('NOT_INITIALISED', 'Repository used before initialise()');
    }
  }

  /** Queue a write. Callers await the returned promise before touching state. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    // Keep the chain alive even when one write rejects.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  /** Last-committed backup of a document, used when the live row is corrupt. */
  private async recover<T>(
    collection: CollectionName,
    id: string,
    guard: (value: unknown) => value is T
  ): Promise<T | null> {
    const backup = await this.store.getBackup(collection, id);
    if (!backup) return null;
    try {
      const value = deserialise<unknown>(collection, id, backup.payload);
      return guard(value) ? value : null;
    } catch {
      return null;
    }
  }

  private async writeDocument<T>(collection: CollectionName, id: string, payload: T): Promise<void> {
    this.assertReady();
    const now = new Date().toISOString();
    const text = serialise(collection, id, payload);

    await this.enqueue(async () => {
      try {
        // Snapshot the last committed payload before overwriting it.
        await this.store.backup(collection, id);
        const existing = await this.store.get(collection, id);
        await this.store.put({
          collection,
          id,
          schemaVersion: SCHEMA_VERSION,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          payload: text,
        });
      } catch (error) {
        throw new RepositoryError(
          'WRITE_FAILED',
          `Could not write ${collection}/${id}`,
          error instanceof Error ? error.message : String(error),
          error
        );
      }
    });
  }

  // ---------------------------------------------------------------- settings

  async getSettings(): Promise<AppSettings> {
    this.assertReady();
    const row = await this.store.get(COLLECTIONS.settings, SETTINGS_ID);
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      return mergeSettings(deserialise<Partial<AppSettings>>(COLLECTIONS.settings, SETTINGS_ID, row.payload));
    } catch {
      const recovered = await this.recover<Partial<AppSettings>>(
        COLLECTIONS.settings,
        SETTINGS_ID,
        (value): value is Partial<AppSettings> => typeof value === 'object' && value !== null
      );
      return recovered ? mergeSettings(recovered) : { ...DEFAULT_SETTINGS };
    }
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.writeDocument(COLLECTIONS.settings, SETTINGS_ID, settings);
  }

  // ------------------------------------------------------------------- sites

  async listSites(): Promise<Site[]> {
    this.assertReady();
    const rows = await this.store.list(COLLECTIONS.sites);
    const sites: Site[] = [];
    for (const row of rows) {
      try {
        const value = deserialise<unknown>(COLLECTIONS.sites, row.id, row.payload);
        if (isSite(value)) sites.push(value);
      } catch {
        const recovered = await this.recover(COLLECTIONS.sites, row.id, isSite);
        if (recovered) sites.push(recovered);
      }
    }
    return sites;
  }

  async getSite(id: string): Promise<Site | null> {
    const direct = await this.readDocumentSafely(COLLECTIONS.sites, id, isSite);
    return direct;
  }

  async saveSite(site: Site): Promise<void> {
    await this.writeDocument(COLLECTIONS.sites, site.id, site);
  }

  async deleteSite(id: string): Promise<void> {
    this.assertReady();
    await this.enqueue(() => this.store.remove(COLLECTIONS.sites, id));
  }

  // ------------------------------------------------------------ measurements

  async listMeasurements(options?: { siteId?: string }): Promise<SavedMeasurement[]> {
    this.assertReady();
    const rows = await this.store.list(COLLECTIONS.measurements);
    const measurements: SavedMeasurement[] = [];
    for (const row of rows) {
      const value = await this.readDocumentSafely(COLLECTIONS.measurements, row.id, isSavedMeasurement);
      if (!value) continue;
      if (options?.siteId && value.siteId !== options.siteId) continue;
      measurements.push(value);
    }
    return measurements.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async getMeasurement(id: string): Promise<SavedMeasurement | null> {
    return this.readDocumentSafely(COLLECTIONS.measurements, id, isSavedMeasurement);
  }

  /**
   * Persist a measurement and register its media. The promise resolves only
   * after the row is committed — screens update their state on the resolution,
   * never before.
   */
  async saveMeasurement(measurement: SavedMeasurement): Promise<void> {
    await this.writeDocument(COLLECTIONS.measurements, measurement.id, measurement);
    await this.enqueue(async () => {
      const createdAt = measurement.createdAt;
      if (measurement.videoUri) {
        await this.store.addMediaRef(measurement.videoUri, measurement.id, 'video', createdAt);
      }
      if (measurement.photoUri) {
        await this.store.addMediaRef(measurement.photoUri, measurement.id, 'photo', createdAt);
      }
    });
  }

  /**
   * Delete a measurement and report which media files it released.
   *
   * A file is only reported as orphaned when no other record references it —
   * a retry that produced a second record must never delete the video the first
   * one still points at.
   */
  async deleteMeasurement(id: string): Promise<{ orphanedMedia: string[] }> {
    this.assertReady();
    const measurement = await this.getMeasurement(id);
    const candidates = [measurement?.videoUri, measurement?.photoUri].filter(
      (uri): uri is string => typeof uri === 'string' && uri.length > 0
    );

    return this.enqueue(async () => {
      await this.store.remove(COLLECTIONS.measurements, id);
      await this.store.removeMediaRefsForOwner(id);

      const orphanedMedia: string[] = [];
      for (const uri of candidates) {
        const remaining = await this.store.countMediaRefs(uri);
        if (remaining === 0) orphanedMedia.push(uri);
      }
      return { orphanedMedia };
    });
  }

  /** How many saved records still point at a media file. */
  async mediaReferenceCount(uri: string): Promise<number> {
    this.assertReady();
    return this.store.countMediaRefs(uri);
  }

  // --------------------------------------------------------- live flow (beta)

  async listLiveSessions(): Promise<unknown[]> {
    this.assertReady();
    const rows = await this.store.list(COLLECTIONS.liveSessions);
    return rows.map((row) => {
      try {
        return deserialise<unknown>(COLLECTIONS.liveSessions, row.id, row.payload);
      } catch {
        return { id: row.id, unreadable: true };
      }
    });
  }

  async saveLiveSession(id: string, payload: unknown): Promise<void> {
    await this.writeDocument(COLLECTIONS.liveSessions, id, payload);
  }

  // ------------------------------------------------------------------ shared

  private async readDocumentSafely<T>(
    collection: CollectionName,
    id: string,
    guard: (value: unknown) => value is T
  ): Promise<T | null> {
    this.assertReady();
    const row = await this.store.get(collection, id);
    if (!row) return null;
    try {
      const value = deserialise<unknown>(collection, id, row.payload);
      if (guard(value)) return value;
      throw new Error('document failed its type guard');
    } catch (error) {
      const recovered = await this.recover(collection, id, guard);
      if (recovered) return recovered;
      throw new RepositoryError(
        'CORRUPT_DOCUMENT',
        `Stored document ${collection}/${id} is unreadable and has no usable backup`,
        error instanceof Error ? error.message : String(error),
        error
      );
    }
  }

  async schemaVersion(): Promise<number> {
    this.assertReady();
    return this.store.schemaVersion();
  }

  /** Wait for every queued write to settle. Used before the app backgrounds. */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

export function createRepository(store: DocumentStore): Repository {
  return new Repository(store);
}
