import { lateralVelocityProfile } from '../../video/lateral-profile';
import { analyse } from '../../video/ssiv-core';
import { makeClip, TEST_DIMENSIONS, TEST_ROI } from './synthetic';
import { ALGORITHM_VERSION } from '../../domain/types';
import { SSIV_THRESHOLDS } from '../../video/types';
import type { EnsembleVector, SsivAnalysis, SsivVector } from '../../video/types';

function baseAnalysis(overrides: Partial<SsivAnalysis> = {}): SsivAnalysis {
  return {
    surfaceVelocity: 1,
    velocitySource: 'instantaneous',
    velocitySpreadMs: 0.02,
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
      totalVectors: 0,
      acceptedVectors: 0,
      rejectedVectors: 0,
      acceptanceRatio: 0,
      rejectionsByReason: {
        LOW_CORRELATION: 0,
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
      cameraCompensationPx: 0.1,
      ensembleNodes: 0,
      acceptedEnsembleNodes: 0,
      ensemblePairsUsed: 6,
      crossFlowRatio: 0,
      crossFlowWarningRatio: SSIV_THRESHOLDS.crossFlowWarningRatio,
      distinctAcceptedColumns: 0,
      staticBackgroundCorrelation: Number.NaN,
      sceneBackgroundCorrelation: Number.NaN,
      backgroundSuppressed: false,
    },
    thresholds: SSIV_THRESHOLDS,
    algorithmVersion: ALGORITHM_VERSION,
    analysedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function vector(gridColumn: number, velocityMs: number, accepted = true): SsivVector {
  return {
    pairIndex: 0,
    gridColumn,
    gridRow: 0,
    x: 0,
    y: 0,
    dxPx: 1,
    dyPx: 1,
    correlation: 0.9,
    peakRatio: 1.2,
    snr: 5,
    uncertaintyPx: 1,
    forwardBackwardPx: 0.1,
    spatialCoherence: 0.9,
    velocityMs,
    accepted,
  };
}

function ensembleNode(gridColumn: number, velocityMs: number, accepted = true): EnsembleVector {
  return {
    gridColumn,
    gridRow: 0,
    x: 0,
    y: 0,
    dxPx: 1,
    dyPx: 1,
    correlation: 0.9,
    peakRatio: 1.2,
    snr: 5,
    uncertaintyPx: 1,
    forwardBackwardPx: 0.1,
    pairsUsed: 6,
    frameDeltaS: 0.1,
    velocityMs,
    accepted,
  };
}

describe('lateral velocity profile', () => {
  it('groups accepted per-pair vectors by column and takes their median', () => {
    const analysis = baseAnalysis({
      velocitySource: 'instantaneous',
      vectors: [
        vector(0, 0.5),
        vector(0, 0.7),
        vector(1, 1.0),
        vector(2, 1.5),
        // Rejected — must not pull the column's median down.
        vector(2, 99, false),
      ],
    });
    const { columns, columnsTotal } = lateralVelocityProfile(analysis);
    expect(columnsTotal).toBe(SSIV_THRESHOLDS.gridColumns);
    expect(columns.map((c) => c.column)).toEqual([0, 1, 2]);
    expect(columns[0]?.surfaceVelocityMs).toBeCloseTo(0.6, 9); // median(0.5, 0.7)
    expect(columns[0]?.sampleCount).toBe(2);
    expect(columns[2]?.surfaceVelocityMs).toBeCloseTo(1.5, 9); // the rejected one excluded
    // u is the same normalisation the SSIV grid itself uses.
    expect(columns[0]?.u).toBeCloseTo(0.5 / SSIV_THRESHOLDS.gridColumns, 9);
  });

  it('reads the ensemble nodes instead when that is the reported source', () => {
    const analysis = baseAnalysis({
      velocitySource: 'ensemble',
      vectors: [vector(0, 999)], // present, but must be ignored
      ensemble: [ensembleNode(0, 0.4), ensembleNode(1, 0.8)],
    });
    const { columns } = lateralVelocityProfile(analysis);
    expect(columns.map((c) => c.column)).toEqual([0, 1]);
    expect(columns[0]?.surfaceVelocityMs).toBeCloseTo(0.4, 9);
  });

  it('leaves a column absent rather than inventing a zero when nothing survived there', () => {
    const analysis = baseAnalysis({
      velocitySource: 'instantaneous',
      vectors: [vector(0, 1), vector(3, 1)], // columns 1 and 2 have nothing
    });
    const { columns, columnsTotal } = lateralVelocityProfile(analysis);
    expect(columnsTotal).toBe(SSIV_THRESHOLDS.gridColumns);
    expect(columns.map((c) => c.column)).toEqual([0, 3]);
  });

  it('reports the true grid width even when the last column has nothing', () => {
    // If columnsTotal were inferred from the highest surviving column index,
    // a missing final column would silently shrink the coverage denominator
    // instead of showing up as a gap.
    const analysis = baseAnalysis({
      velocitySource: 'instantaneous',
      vectors: [vector(0, 1), vector(1, 1)], // columns 2, 3 absent
    });
    const { columnsTotal } = lateralVelocityProfile(analysis);
    expect(columnsTotal).toBe(SSIV_THRESHOLDS.gridColumns);
  });

  it('builds a real, usable profile from an actual analyse() run', () => {
    const result = analyse({
      clip: makeClip({ pairs: 6 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { columns, columnsTotal } = lateralVelocityProfile(result.value);
    expect(columnsTotal).toBe(SSIV_THRESHOLDS.gridColumns);
    expect(columns.length).toBeGreaterThan(0);
    // The synthetic clip moves uniformly, so every column should read close
    // to the same velocity as the analysis's own headline figure.
    for (const column of columns) {
      expect(column.surfaceVelocityMs).toBeCloseTo(result.value.surfaceVelocity, 1);
    }
  });
});
