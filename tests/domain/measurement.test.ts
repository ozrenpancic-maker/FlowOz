import { buildSavedMeasurement, calculate } from '../../domain/measurement';
import { createDisplayId, createId } from '../../domain/ids';
import { UNCERTAINTY_WITHHELD, assess, gradeGeometry, gradeLevel, gradeVelocity, worstGrade } from '../../domain/quality';
import { retryDraftFrom } from '../../domain/draft';
import { ALGORITHM_VERSION, MEASUREMENT_VERSION } from '../../domain/types';
import { makeDraft, makeMeasurement } from '../storage/fixtures';
import type { SsivAnalysis } from '../../video/types';
import { SSIV_THRESHOLDS } from '../../video/types';

function fakeAnalysis(overrides: Partial<SsivAnalysis> = {}): SsivAnalysis {
  return {
    surfaceVelocity: 1.2,
    velocitySource: 'ensemble',
    ensembleVelocity: 1.2,
    instantaneousVelocity: 1.19,
    velocitySpreadMs: 0.05,
    ensembleSpreadMs: 0.03,
    calibrationStatus: 'VALID',
    frameWidth: 240,
    frameHeight: 135,
    sourceWidth: 1280,
    sourceHeight: 720,
    sampledPairs: 6,
    frameDeltaS: 0.1,
    stabilisation: [],
    vectors: [],
    ensemble: [],
    quality: {
      totalVectors: 120,
      acceptedVectors: 80,
      rejectedVectors: 40,
      acceptanceRatio: 80 / 120,
      rejectionsByReason: {
        LOW_CORRELATION: 40,
        WEAK_PEAK_SEPARATION: 0,
        HIGH_UNCERTAINTY: 0,
        FORWARD_BACKWARD_MISMATCH: 0,
        SEARCH_WINDOW_EDGE: 0,
        DIRECTIONAL_OUTLIER: 0,
        SPATIAL_OUTLIER: 0,
        NON_FINITE: 0,
      },
      stablePairs: 6,
      totalPairs: 6,
      medianCorrelation: 0.8,
      cameraCompensationPx: 0.3,
      ensembleNodes: 20,
      acceptedEnsembleNodes: 16,
      ensemblePairsUsed: 6,
    },
    thresholds: SSIV_THRESHOLDS,
    algorithmVersion: ALGORITHM_VERSION,
    analysedAt: '2026-09-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('calculate', () => {
  it('computes a Manning measurement end to end', () => {
    const result = calculate(makeDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flowM3s).toBeGreaterThan(0);
    expect(result.value.provenance.velocity).toBe('ESTIMATED');
    expect(result.value.provenance.flow).toBe('CALCULATED');
    expect(result.value.quality.uncertainty).toBe(UNCERTAINTY_WITHHELD);
  });

  it('computes a video measurement with alpha applied', () => {
    const analysis = fakeAnalysis();
    const result = calculate(makeDraft({ method: 'video', alpha: 0.9 }), { analysis });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceVelocity).toBeCloseTo(1.2, 12);
    expect(result.value.velocity).toBeCloseTo(1.08, 12);
    expect(result.value.flowM3s).toBeCloseTo(result.value.section.area * 1.08, 12);
    expect(result.value.provenance.velocity).toBe('MEASURED_VIDEO');
  });

  it('blocks on a physically impossible value before touching the geometry', () => {
    const result = calculate(makeDraft({ depth: -0.5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PLAUSIBILITY_BLOCKED');
      expect(result.error.plausibility?.blocked).toBe(true);
    }
  });

  it('reports a geometry failure with the field to correct', () => {
    const result = calculate(makeDraft({ depth: 0.4 })); // h = D
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('GEOMETRY');
      expect(result.error.field).toBe('depth');
    }
  });

  it('names the missing input rather than substituting a default', () => {
    const noSlope = calculate(makeDraft({ slopePermille: null }));
    expect(noSlope.ok).toBe(false);
    if (!noSlope.ok) expect(noSlope.error.code).toBe('MISSING_INPUT');

    const noVelocity = calculate(makeDraft({ method: 'manual', manualVelocity: null }));
    expect(noVelocity.ok).toBe(false);
    if (!noVelocity.ok) expect(noVelocity.error.field).toBe('velocity');

    const noSurface = calculate(makeDraft({ method: 'video' }));
    expect(noSurface.ok).toBe(false);
    if (!noSurface.ok) expect(noSurface.error.field).toBe('surfaceVelocity');
  });

  it('keeps an unusual but possible value exactly as entered', () => {
    const draft = makeDraft({ roughness: 0.3 }); // heavy vegetation: unusual, real
    const result = calculate(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plausibility.advisories).toHaveLength(1);
    expect(draft.roughness).toBe(0.3); // untouched
  });
});

describe('quality grading', () => {
  it('takes the worst component as the overall grade', () => {
    expect(worstGrade('A', 'B', 'C')).toBe('C');
    expect(worstGrade('A', 'A')).toBe('A');
    expect(worstGrade('B', 'INVALID')).toBe('INVALID');
  });

  it('caps camera-assisted level at B and says why', () => {
    const level = gradeLevel({
      provenance: 'MEASURED',
      depthValid: true,
      cameraAssisted: { residualPx: 0.4, pointCount: 12 },
    });
    expect(level.grade).toBe('B');
    expect(level.reasonKey).toBe('quality.level.cameraNotMetrologicallyValidated');
  });

  it('never grades video velocity as A, however good the run', () => {
    const velocity = gradeVelocity({
      method: 'video',
      velocityValid: true,
      video: { acceptedVectors: 110, totalVectors: 120, calibrationStatus: 'VALID', stablePairs: 6 },
      alphaCalibrated: true,
    });
    expect(velocity.grade).toBe('B');
  });

  it('invalidates video velocity when the calibration is not VALID', () => {
    const velocity = gradeVelocity({
      method: 'video',
      velocityValid: true,
      video: { acceptedVectors: 110, totalVectors: 120, calibrationStatus: 'POOR', stablePairs: 6 },
    });
    expect(velocity.grade).toBe('INVALID');
    expect(velocity.detail).toBe('POOR');
  });

  it('always states a reason, on every component', () => {
    const assessment = assess(
      gradeGeometry({ provenance: 'SITE', hasAdvisories: false, sectionValid: true }),
      gradeLevel({ provenance: 'ENTERED', depthValid: true }),
      gradeVelocity({ method: 'manning', velocityValid: true })
    );
    for (const component of [assessment.geometry, assessment.level, assessment.velocity, assessment.overall]) {
      expect(component.reasonKey).toBeTruthy();
    }
    expect(assessment.uncertainty).toBe(UNCERTAINTY_WITHHELD);
  });
});

describe('saved measurement assembly', () => {
  it('carries an immutable evidence snapshot', () => {
    const draft = makeDraft();
    const outcome = calculate(draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const measurement = buildSavedMeasurement('m-1', 'FV-1', draft, outcome.value);
    // Mutating the draft afterwards must not touch the saved record.
    draft.depth = 0.99;
    expect(measurement.raw.draft.depth).toBe(0.15);
    expect(measurement.measurementVersion).toBe(MEASUREMENT_VERSION);
    expect(measurement.algorithmVersion).toBe(ALGORITHM_VERSION);
  });

  it('marks a video measurement PROCESSED only with an analysis attached', () => {
    const draft = makeDraft({ method: 'video', surfaceVelocity: 1.2 });
    const outcome = calculate(draft);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const withoutAnalysis = buildSavedMeasurement('m-2', 'FV-2', draft, outcome.value);
    expect(withoutAnalysis.processingStatus).toBe('CAPTURED');

    const withAnalysis = buildSavedMeasurement('m-3', 'FV-3', draft, outcome.value, {
      analysis: fakeAnalysis(),
    });
    expect(withAnalysis.processingStatus).toBe('PROCESSED');
    expect(withAnalysis.videoAnalysis).toBeDefined();
  });

  it('records the fill ratio for a circular section only', () => {
    const circular = makeMeasurement('m-circ');
    expect(circular.fillRatio).toBeCloseTo(0.375, 12);

    const rectangular = makeMeasurement('m-rect', {
      dimensions: { kind: 'rectangular', width: 1 },
      geometry: 'rectangular',
    });
    expect(rectangular.fillRatio).toBeUndefined();
  });
});

describe('identifiers', () => {
  it('produces unique ids and readable display ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createId('m')));
    expect(ids.size).toBe(200);
    expect(createDisplayId('FV', new Date('2026-09-10T14:23:00'))).toMatch(/^FV-260910-\d{4}-[0-9A-Z]{3}$/);
  });
});

describe('retry draft', () => {
  it('keeps site, geometry, depth, video, ROI and scale but clears the result', () => {
    const original = {
      ...makeMeasurement('m-video', { method: 'video', surfaceVelocity: 1.2 }),
      siteId: 'site-1',
      siteName: 'Outfall MH-12',
      videoUri: 'file:///docs/video-1.mp4',
      videoDuration: 5,
      videoSource: 'camera' as const,
      waterRoi: {
        topLeft: { x: 0.2, y: 0.2 },
        topRight: { x: 0.8, y: 0.2 },
        bottomRight: { x: 0.8, y: 0.8 },
        bottomLeft: { x: 0.2, y: 0.8 },
      },
      perspectiveScale: { widthM: 2, lengthM: 3 },
      surfaceVelocity: 1.2,
      alpha: 0.9,
    };

    const retry = retryDraftFrom(original);
    expect(retry.siteId).toBe('site-1');
    expect(retry.depth).toBe(original.depth);
    expect(retry.dimensions).toEqual(original.dimensions);
    expect(retry.videoUri).toBe('file:///docs/video-1.mp4');
    expect(retry.waterRoi).toEqual(original.waterRoi);
    expect(retry.knownRoiDimensions).toEqual({ widthM: 2, lengthM: 3 });
    expect(retry.alpha).toBe(0.9);
    expect(retry.method).toBe('video');

    // The previous result is the one thing a retry must not inherit.
    expect(retry.surfaceVelocity).toBeUndefined();

    // The saved record itself is untouched.
    expect(original.surfaceVelocity).toBe(1.2);
  });
});
