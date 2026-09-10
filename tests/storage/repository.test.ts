import { MemoryDocumentStore } from '../../storage/document-store';
import { MIGRATIONS, SCHEMA_VERSION, migrationsToRun } from '../../storage/migrations';
import { Repository, RepositoryError } from '../../storage/repository';
import { COLLECTIONS, escapeCellFixtureGuard, indexRow, isSavedMeasurement, isSite, mergeSettingsGuard } from './helpers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../storage/settings';
import { makeMeasurement, makeSite } from './fixtures';

function freshRepository() {
  const store = new MemoryDocumentStore(SCHEMA_VERSION);
  return { store, repository: new Repository(store) };
}

describe('migrations', () => {
  it('runs every migration on a new database, in order', () => {
    const pending = migrationsToRun(0);
    expect(pending).toHaveLength(MIGRATIONS.length);
    expect(pending.map((m) => m.version)).toEqual([...pending].sort((a, b) => a.version - b.version).map((m) => m.version));
  });

  it('runs only the newer migrations on an existing database', () => {
    expect(migrationsToRun(1).every((m) => m.version > 1)).toBe(true);
    expect(migrationsToRun(SCHEMA_VERSION)).toHaveLength(0);
  });

  it('never drops a document table', () => {
    const statements = MIGRATIONS.flatMap((m) => m.statements).join('\n').toUpperCase();
    expect(statements).not.toContain('DROP TABLE');
    expect(statements).not.toContain('DELETE FROM');
  });

  it('is written to be replayable after an interrupted upgrade', () => {
    for (const migration of MIGRATIONS) {
      for (const statement of migration.statements) {
        expect(statement.toUpperCase()).toContain('IF NOT EXISTS');
      }
    }
  });
});

describe('repository lifecycle', () => {
  it('refuses to be used before initialise()', async () => {
    const { repository } = freshRepository();
    await expect(repository.listMeasurements()).rejects.toBeInstanceOf(RepositoryError);
  });

  it('reports the schema version it initialised to', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    expect(await repository.schemaVersion()).toBe(SCHEMA_VERSION);
  });
});

describe('measurements', () => {
  it('saves and reads a measurement back unchanged', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    const measurement = makeMeasurement();

    await repository.saveMeasurement(measurement);
    const reopened = await repository.getMeasurement(measurement.id);
    expect(reopened).toEqual(measurement);
  });

  it('survives an application restart', async () => {
    const store = new MemoryDocumentStore(SCHEMA_VERSION);
    const first = new Repository(store);
    await first.initialise();
    const measurement = makeMeasurement('m-restart');
    await first.saveMeasurement(measurement);
    await first.flush();

    // A second repository over the same durable store is what a restart is.
    const second = new Repository(store);
    await second.initialise();
    const reopened = await second.getMeasurement('m-restart');
    expect(reopened?.id).toBe('m-restart');
    expect(reopened?.raw).toEqual(measurement.raw);
    expect(reopened?.flowM3s).toBeCloseTo(measurement.flowM3s as number, 12);
  });

  it('serialises concurrent writes instead of interleaving them', async () => {
    const { store, repository } = freshRepository();
    await repository.initialise();

    const order: string[] = [];
    const originalPut = store.put.bind(store);
    jest.spyOn(store, 'put').mockImplementation(async (row) => {
      order.push(`start:${row.id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await originalPut(row);
      order.push(`end:${row.id}`);
    });

    await Promise.all([
      repository.saveMeasurement(makeMeasurement('m-a')),
      repository.saveMeasurement(makeMeasurement('m-b')),
      repository.saveMeasurement(makeMeasurement('m-c')),
    ]);

    // Every write completes before the next one starts.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]?.replace('start:', '')).toBe(order[i + 1]?.replace('end:', ''));
    }
    expect(await repository.listMeasurements()).toHaveLength(3);
  });

  it('lists newest first and filters by site', async () => {
    const { repository } = freshRepository();
    await repository.initialise();

    await repository.saveMeasurement({
      ...makeMeasurement('m-old', {}, '2026-09-01T08:00:00.000Z'),
      siteId: 'site-1',
      siteName: 'A',
    });
    await repository.saveMeasurement({
      ...makeMeasurement('m-new', {}, '2026-09-10T08:00:00.000Z'),
      siteId: 'site-2',
      siteName: 'B',
    });

    const all = await repository.listMeasurements();
    expect(all.map((m) => m.id)).toEqual(['m-new', 'm-old']);
    expect((await repository.listMeasurements({ siteId: 'site-1' })).map((m) => m.id)).toEqual(['m-old']);
  });

  it('reports a write failure instead of updating state silently', async () => {
    const { store, repository } = freshRepository();
    await repository.initialise();
    jest.spyOn(store, 'put').mockRejectedValue(new Error('disk full'));

    await expect(repository.saveMeasurement(makeMeasurement('m-fail'))).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
  });
});

describe('backup recovery', () => {
  it('recovers the last committed document when the live row is corrupt', async () => {
    const { store, repository } = freshRepository();
    await repository.initialise();

    const first = makeMeasurement('m-recover', {}, '2026-09-10T10:00:00.000Z');
    await repository.saveMeasurement(first);
    // A second write snapshots the first payload into the backup table.
    await repository.saveMeasurement({ ...first, notes: 'second revision' });
    store.corrupt(COLLECTIONS.measurements, 'm-recover');

    const recovered = await repository.getMeasurement('m-recover');
    expect(recovered).not.toBeNull();
    expect(recovered?.id).toBe('m-recover');
    expect(recovered?.notes).toBeUndefined(); // the last committed payload
  });

  it('throws a typed error when neither the row nor the backup is readable', async () => {
    const { store, repository } = freshRepository();
    await repository.initialise();
    await repository.saveMeasurement(makeMeasurement('m-lost'));
    store.corrupt(COLLECTIONS.measurements, 'm-lost');

    await expect(repository.getMeasurement('m-lost')).rejects.toMatchObject({
      code: 'CORRUPT_DOCUMENT',
    });
  });

  it('returns null for a document that was never written', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    expect(await repository.getMeasurement('nope')).toBeNull();
    expect(await repository.getSite('nope')).toBeNull();
  });
});

describe('media reference counting', () => {
  it('keeps a video that a second measurement still references', async () => {
    const { repository } = freshRepository();
    await repository.initialise();

    const videoUri = 'file:///docs/flowvision-media/video-1.mp4';
    const original = { ...makeMeasurement('m-original'), videoUri };
    const retry = { ...makeMeasurement('m-retry'), videoUri };
    await repository.saveMeasurement(original);
    await repository.saveMeasurement(retry);
    expect(await repository.mediaReferenceCount(videoUri)).toBe(2);

    // Deleting one record must not orphan the file the other still points at.
    const firstDelete = await repository.deleteMeasurement('m-original');
    expect(firstDelete.orphanedMedia).toEqual([]);

    const secondDelete = await repository.deleteMeasurement('m-retry');
    expect(secondDelete.orphanedMedia).toEqual([videoUri]);
  });

  it('reports a video as orphaned once its only record is gone', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    const videoUri = 'file:///docs/flowvision-media/video-2.mp4';
    await repository.saveMeasurement({ ...makeMeasurement('m-solo'), videoUri });

    const result = await repository.deleteMeasurement('m-solo');
    expect(result.orphanedMedia).toEqual([videoUri]);
    expect(await repository.getMeasurement('m-solo')).toBeNull();
  });
});

describe('sites and settings', () => {
  it('round-trips a site', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    const site = makeSite();
    await repository.saveSite(site);
    expect(await repository.getSite(site.id)).toEqual(site);
    expect(await repository.listSites()).toHaveLength(1);
  });

  it('returns the defaults when nothing has been saved', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    expect(await repository.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips settings and merges an older document onto the defaults', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    await repository.saveSettings({ ...DEFAULT_SETTINGS, language: 'hr', csvFormat: 'excel' });

    const stored = await repository.getSettings();
    expect(stored.language).toBe('hr');
    expect(stored.csvFormat).toBe('excel');
    expect(stored.defaultAlpha).toBe(DEFAULT_SETTINGS.defaultAlpha);

    // A document written by an older version keeps its known fields.
    // GPS capture is on unless the operator turned it off, so a document from
    // before the flag existed opts in rather than losing position silently.
    expect(mergeSettings({ language: 'hr' } as never).captureGpsWithMeasurements).toBe(true);
    expect(
      mergeSettings({ captureGpsWithMeasurements: false } as never).captureGpsWithMeasurements
    ).toBe(false);
    expect(mergeSettings(null).language).toBe('en');
    expect(mergeSettings({ defaultAlpha: -1 } as never).defaultAlpha).toBe(DEFAULT_SETTINGS.defaultAlpha);
  });

  it('preserves Live Flow session documents untouched', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    await repository.saveLiveSession('live-1', { experimental: true, samples: [1, 2, 3] });
    expect(await repository.listLiveSessions()).toEqual([{ experimental: true, samples: [1, 2, 3] }]);
  });
});

describe('serialisation guards', () => {
  it('recognises a well-formed measurement and a well-formed site', () => {
    expect(isSavedMeasurement(makeMeasurement())).toBe(true);
    expect(isSite(makeSite())).toBe(true);
  });

  it('rejects documents that are not what they claim to be', () => {
    expect(isSavedMeasurement({ id: 'x' })).toBe(false);
    expect(isSavedMeasurement(null)).toBe(false);
    expect(isSite({ id: 'x', name: 'y' })).toBe(false);
  });

  it('indexes a withheld discharge as null, never as zero', () => {
    const measurement = makeMeasurement();
    const withheld = { ...measurement };
    delete (withheld as { flowM3s?: number }).flowM3s;

    expect(indexRow(measurement).flowM3s).toBeCloseTo(measurement.flowM3s as number, 12);
    expect(indexRow(withheld).flowM3s).toBeNull();
  });

  it('keeps the helper fixtures honest', () => {
    expect(escapeCellFixtureGuard()).toBe(true);
    expect(mergeSettingsGuard()).toBe(true);
  });
});
