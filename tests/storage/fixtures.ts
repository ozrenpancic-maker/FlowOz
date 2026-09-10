import { buildSavedMeasurement, calculate, type SavedMeasurement } from '../../domain/measurement';
import type { MeasurementDraft, Site } from '../../domain/types';
import { DEFAULT_ALPHA } from '../../domain/types';

/** A complete, calculable draft used across the storage and report tests. */
export function makeDraft(overrides: Partial<MeasurementDraft> = {}): MeasurementDraft {
  return {
    geometry: 'circular',
    dimensions: { kind: 'circular', diameter: 0.4 },
    unit: 'mm',
    depth: 0.15,
    levelMethod: 'manual',
    method: 'manning',
    roughness: 0.013,
    slopePermille: 5,
    manualVelocity: null,
    alpha: DEFAULT_ALPHA,
    alphaProvenance: 'ASSUMED',
    ...overrides,
  };
}

export function makeMeasurement(
  id = 'm-1',
  overrides: Partial<MeasurementDraft> = {},
  createdAt = '2026-09-10T12:00:00.000Z'
): SavedMeasurement {
  const draft = makeDraft(overrides);
  const outcome = calculate(draft);
  if (!outcome.ok) {
    throw new Error(`fixture draft does not calculate: ${outcome.error.code} ${outcome.error.detail ?? ''}`);
  }
  return buildSavedMeasurement(id, `FV-${id.toUpperCase()}`, draft, outcome.value, { createdAt });
}

export function makeSite(id = 'site-1'): Site {
  return {
    id,
    name: 'Outfall MH-12',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
    draft: makeDraft(),
    alpha: DEFAULT_ALPHA,
    alphaStatus: 'default',
    calibrationPoints: [],
  };
}
