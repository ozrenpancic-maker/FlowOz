import { MemoryDocumentStore } from '../../storage/document-store';
import { MIGRATIONS, SCHEMA_VERSION, migrationsToRun } from '../../storage/migrations';
import { Repository, RepositoryError } from '../../storage/repository';
import { COLLECTIONS, escapeCellFixtureGuard, indexRow, isSavedMeasurement, isSite, mergeSettingsGuard } from './helpers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../storage/settings';
import { makeMeasurement, makeSite } from './fixtures';
import { buildValidationRecord } from '../../domain/validation-record';
import type { SavedMeasurement } from '../../domain/measurement';
import { buildReportModel } from '../../reports/report-model';
import { measurementRow, toCsv } from '../../reports/csv';

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

  it('round-trips a full sensor snapshot through real JSON serialisation, including every optional sub-object', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    const measurement = makeMeasurement('m-snapshot', {
      method: 'video',
      surfaceVelocity: 1.1,
      sensorSnapshot: {
        timestamp: 1_700_000_000_000,
        device: { manufacturer: 'Google', model: 'Pixel 8', androidVersion: '15', appVersion: '1.0.1', algorithmVersion: 'ssiv-1.0.0' },
        camera: {
          available: true,
          facing: 'back',
          sourceWidth: 1280,
          sourceHeight: 720,
          nominalFps: 30,
          actualFps: 29.8,
          zoom: 0,
          intrinsicsAvailable: false,
          distortionAvailable: false,
        },
        motion: {
          accelerometerAvailable: true,
          gyroscopeAvailable: true,
          deviceMotionAvailable: true,
          pitchDeg: 12.3,
          rollDeg: -1.2,
          angularVelocityRmsDegPerSec: 0.21,
          accelerationRmsMps2: 0.1,
          gravityVector: { x: 0, y: 0.02, z: 0.99 },
          sampleCount: 42,
          windowDurationS: 3.1,
        },
        location: { available: true, latitude: 45.8, longitude: 16.0, accuracyM: 4.2 },
        magnetic: { available: true, headingDeg: 91.2, quality: 'QUESTIONABLE' },
        pressure: { available: true, atmosphericPressureHpa: 1012.5 },
        imageQuality: {
          meanLuminance: 128,
          darkPixelFraction: 0.05,
          saturatedPixelFraction: 0,
          localContrast: 9.5,
          blurScore: 24,
          glareScore: 0.01,
          sampleWidth: 240,
          sampleHeight: 135,
        },
        depthCapability: { arcoreSupported: 'UNKNOWN', depthSupported: 'UNKNOWN', tofAccessible: 'UNKNOWN' },
      },
    });

    await repository.saveMeasurement(measurement);
    const reopened = await repository.getMeasurement(measurement.id);
    expect(reopened?.sensorSnapshot).toEqual(measurement.sensorSnapshot);
    expect(reopened).toEqual(measurement);
  });

  it('completes a video measurement whose sensor snapshot has every optional sensor unavailable', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    const measurement = makeMeasurement('m-no-sensors', {
      method: 'video',
      surfaceVelocity: 1.1,
      sensorSnapshot: {
        timestamp: Date.now(),
        device: { appVersion: '1.0.1', algorithmVersion: 'ssiv-1.0.0' },
        camera: { available: false, intrinsicsAvailable: false, distortionAvailable: false },
        motion: { accelerometerAvailable: false, gyroscopeAvailable: false, deviceMotionAvailable: false },
      },
    });

    await repository.saveMeasurement(measurement);
    const reopened = await repository.getMeasurement(measurement.id);
    expect(reopened?.flowM3s).toBeGreaterThan(0);
    expect(reopened?.dataQuality.cameraStability?.grade).toBe('C');
    expect(reopened?.dataQuality.cameraStability?.reasonKey).toBe('quality.cameraStability.unknown');
    expect(reopened?.dataQuality.imageQuality).toBeUndefined();
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

  it('loads a genuinely old record — written before sensorSnapshot and cameraLevelEvidence existed — without failure', async () => {
    // A hand-built payload matching the pre-Phase-2 shape: no sensorSnapshot,
    // no cameraLevelEvidence, no flowDirection, no lateral/speed diagnostics.
    // This is what a real device's pre-upgrade database row looks like —
    // not a fixture that merely omits optional constructor arguments.
    const { repository, store } = freshRepository();
    await repository.initialise();
    const oldRecord = {
      id: 'm-old',
      createdAt: '2025-01-01T00:00:00.000Z',
      geometry: 'circular',
      dimensions: { kind: 'circular', diameter: 0.4 },
      depth: 0.15,
      unit: 'mm',
      levelMethod: 'manual',
      method: 'manning',
      roughness: 0.013,
      slope: 0.005,
      velocity: 1.0,
      area: 0.02,
      wettedPerimeter: 0.5,
      hydraulicRadius: 0.04,
      flowM3s: 0.02,
      alpha: 0.85,
      measurementVersion: 1,
      algorithmVersion: 'manning-1.0.0',
      processingStatus: 'PROCESSED',
      confidence: 'B',
      dataQuality: {
        geometry: { grade: 'A', reasonKey: 'quality.geometry.fromSite' },
        level: { grade: 'A', reasonKey: 'quality.level.manualEntry' },
        velocity: { grade: 'A', reasonKey: 'quality.velocity.manning' },
        overall: { grade: 'A', reasonKey: 'quality.velocity.manning' },
        uncertainty: 'UNCERTAINTY NOT YET CALCULATED',
      },
      provenance: { geometry: 'SITE', depth: 'MEASURED', velocity: 'CALCULATED', alpha: 'ASSUMED', flow: 'CALCULATED' },
      raw: { draft: {}, plausibility: { advisories: [], blocked: false } },
    };
    await store.put({
      collection: COLLECTIONS.measurements,
      id: 'm-old',
      schemaVersion: SCHEMA_VERSION,
      createdAt: oldRecord.createdAt,
      updatedAt: oldRecord.createdAt,
      payload: JSON.stringify(oldRecord),
    });

    const reopened = await repository.getMeasurement('m-old');
    expect(reopened).not.toBeNull();
    expect(reopened?.id).toBe('m-old');
    expect(reopened?.sensorSnapshot).toBeUndefined();
    expect(reopened?.cameraLevelEvidence).toBeUndefined();
    expect(reopened?.flowDirection).toBeUndefined();
    // And every downstream consumer that reads these optional fields must
    // still work rather than throw — never silently erase the old record.
    expect(() => buildReportModel(reopened as SavedMeasurement, DEFAULT_SETTINGS)).not.toThrow();
    expect(() => toCsv([reopened as SavedMeasurement], 'international')).not.toThrow();
    const row = measurementRow(reopened as SavedMeasurement);
    expect(row.camera_lens).toBe('');
    expect(row.timing_source).toBe('');
    expect(row.streamwise_velocity_m_s).toBeNull();
  });

  it('loads an old camera-assisted-level record that predates cameraLevelEvidence, using the pre-consolidation field names', async () => {
    const { repository, store } = freshRepository();
    await repository.initialise();
    const oldRecord = {
      id: 'm-old-level',
      createdAt: '2025-02-01T00:00:00.000Z',
      geometry: 'circular',
      dimensions: { kind: 'circular', diameter: 0.4 },
      depth: 0.2,
      unit: 'mm',
      levelMethod: 'camera-assisted',
      method: 'manning',
      // Pre-consolidation (Phase before task #32): three separate fields
      // instead of one cameraLevelEvidence structure.
      cameraLevelRimPoints: [{ x: 1, y: 1 }],
      cameraLevelWaterlinePoints: [{ x: 1, y: 2 }],
      cameraLevelFit: { residual: 0.1, inlierCount: 10 },
      roughness: 0.013,
      slope: 0.005,
      velocity: 1.0,
      flowM3s: 0.02,
      alpha: 0.85,
      measurementVersion: 1,
      algorithmVersion: 'manning-1.0.0',
      processingStatus: 'PROCESSED',
      confidence: 'B',
      dataQuality: {
        geometry: { grade: 'A', reasonKey: 'quality.geometry.fromSite' },
        level: { grade: 'C', reasonKey: 'quality.level.cameraWeakFit' },
        velocity: { grade: 'A', reasonKey: 'quality.velocity.manning' },
        overall: { grade: 'C', reasonKey: 'quality.level.cameraWeakFit' },
        uncertainty: 'UNCERTAINTY NOT YET CALCULATED',
      },
      provenance: { geometry: 'SITE', depth: 'MEASURED', velocity: 'CALCULATED', alpha: 'ASSUMED', flow: 'CALCULATED' },
      raw: { draft: {}, plausibility: { advisories: [], blocked: false } },
    };
    await store.put({
      collection: COLLECTIONS.measurements,
      id: 'm-old-level',
      schemaVersion: SCHEMA_VERSION,
      createdAt: oldRecord.createdAt,
      updatedAt: oldRecord.createdAt,
      payload: JSON.stringify(oldRecord),
    });

    const reopened = await repository.getMeasurement('m-old-level');
    expect(reopened).not.toBeNull();
    // The new, canonical field is simply absent — never guessed from the old
    // scattered fields, and never a reason to reject the record.
    expect(reopened?.cameraLevelEvidence).toBeUndefined();
    expect(() => buildReportModel(reopened as SavedMeasurement, DEFAULT_SETTINGS)).not.toThrow();
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

  it('round-trips a validation record and deletes it cleanly', async () => {
    const { repository } = freshRepository();
    await repository.initialise();
    const record = buildValidationRecord('v-1', makeMeasurement('m-for-validation'), {
      flowM3s: 0.045,
    });
    await repository.saveValidationRecord(record);
    expect(await repository.getValidationRecord('v-1')).toEqual(record);
    expect(await repository.listValidationRecords()).toHaveLength(1);

    await repository.deleteValidationRecord('v-1');
    expect(await repository.getValidationRecord('v-1')).toBeNull();
    expect(await repository.listValidationRecords()).toHaveLength(0);
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
