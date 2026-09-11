import { buildValidationRecord } from '../../domain/validation-record';
import { makeMeasurement } from '../storage/fixtures';
import type { SsivAnalysis } from '../../video/types';
import { SSIV_THRESHOLDS } from '../../video/types';
import { ALGORITHM_VERSION } from '../../domain/types';

function fakeVector(snr: number, accepted = true) {
  return {
    pairIndex: 0,
    gridColumn: 0,
    gridRow: 0,
    x: 0,
    y: 0,
    dxPx: 1,
    dyPx: 1,
    correlation: 0.9,
    peakRatio: 1.2,
    snr,
    uncertaintyPx: 1,
    forwardBackwardPx: 0.1,
    spatialCoherence: 0.9,
    velocityMs: 1,
    accepted,
  };
}

function fakeAnalysis(overrides: Partial<SsivAnalysis> = {}): SsivAnalysis {
  return {
    surfaceVelocity: 1.2,
    velocitySource: 'instantaneous',
    velocitySpreadMs: 0.05,
    calibrationStatus: 'VALID',
    frameWidth: 240,
    frameHeight: 135,
    sourceWidth: 1280,
    sourceHeight: 720,
    sampledPairs: 6,
    frameDeltaS: 0.1,
    stabilisation: [],
    vectors: [fakeVector(4), fakeVector(6), fakeVector(8, false)],
    ensemble: [],
    quality: {
      totalVectors: 3,
      acceptedVectors: 2,
      rejectedVectors: 1,
      acceptanceRatio: 2 / 3,
      rejectionsByReason: {
        LOW_CORRELATION: 1,
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
      distinctAcceptedColumns: 2,
      staticBackgroundCorrelation: Number.NaN,
      backgroundSuppressed: false,
    },
    thresholds: SSIV_THRESHOLDS,
    algorithmVersion: ALGORITHM_VERSION,
    analysedAt: '2026-09-10T12:00:00.000Z',
    ...overrides,
  };
}

describe('buildValidationRecord', () => {
  it('carries the reference value only when the operator supplied one', () => {
    const withoutRef = buildValidationRecord('v-1', makeMeasurement('m-1'));
    expect(withoutRef.referenceFlowM3s).toBeUndefined();

    const withRef = buildValidationRecord('v-2', makeMeasurement('m-2'), { flowM3s: 0.05, velocityMs: 0.9 });
    expect(withRef.referenceFlowM3s).toBe(0.05);
    expect(withRef.referenceVelocityMs).toBe(0.9);
  });

  it('carries FlowVision’s own result from the saved measurement', () => {
    const measurement = makeMeasurement('m-3');
    const record = buildValidationRecord('v-3', measurement);
    expect(record.flowVisionFlowM3s).toBe(measurement.flowM3s);
  });

  it('pulls camera angle and motion evidence from the sensor snapshot when present', () => {
    const measurement = {
      ...makeMeasurement('m-4', {
        method: 'video',
        surfaceVelocity: 1.2,
        sensorSnapshot: {
          timestamp: Date.now(),
          device: { model: 'Pixel 8', appVersion: '1.0.1', algorithmVersion: 'ssiv-1.0.0' },
          camera: { available: true, facing: 'back' as const, intrinsicsAvailable: false, distortionAvailable: false },
          motion: {
            accelerometerAvailable: true,
            gyroscopeAvailable: true,
            deviceMotionAvailable: true,
            pitchDeg: 12,
            rollDeg: 2,
            angularVelocityRmsDegPerSec: 0.3,
            accelerationRmsMps2: 0.2,
          },
          imageQuality: {
            meanLuminance: 130,
            darkPixelFraction: 0.05,
            saturatedPixelFraction: 0,
            localContrast: 9,
            blurScore: 22,
            glareScore: 0.02,
            sampleWidth: 240,
            sampleHeight: 135,
          },
        },
      }),
    };
    const record = buildValidationRecord('v-4', measurement);
    expect(record.pitchDeg).toBe(12);
    expect(record.rollDeg).toBe(2);
    expect(record.angularVelocityRmsDegPerSec).toBe(0.3);
    expect(record.accelerationRmsMps2).toBe(0.2);
    expect(record.imageMeanLuminance).toBe(130);
    expect(record.blurScore).toBe(22);
    expect(record.glareScore).toBe(0.02);
    expect(record.deviceModel).toBe('Pixel 8');
    expect(record.cameraFacing).toBe('back');
  });

  it('never invents camera evidence when there is no sensor snapshot at all', () => {
    const record = buildValidationRecord('v-5', makeMeasurement('m-5'));
    expect(record.pitchDeg).toBeUndefined();
    expect(record.blurScore).toBeUndefined();
    expect(record.deviceModel).toBeUndefined();
  });

  it('computes the accepted vector ratio and median SNR from a real video analysis', () => {
    const analysis = fakeAnalysis();
    const measurement = {
      ...makeMeasurement('m-6', { method: 'video', surfaceVelocity: 1.2 }),
      videoAnalysis: analysis,
      calibrationStatus: analysis.calibrationStatus,
    };
    const record = buildValidationRecord('v-6', measurement);
    expect(record.acceptedVectorRatio).toBeCloseTo(2 / 3, 9);
    // Only the two accepted vectors (snr 4 and 6) feed the median, not the
    // rejected one (snr 8).
    expect(record.medianSnr).toBe(5);
    expect(record.calibrationStatus).toBe('VALID');
  });

  it('never fabricates a numericalClosureErrorPx field the analysis does not actually carry', () => {
    const record = buildValidationRecord('v-7', makeMeasurement('m-7'));
    expect('numericalClosureErrorPx' in record).toBe(false);
  });

  it('carries waterDepthM, crossFlowRatio and timingSource when the measurement has them', () => {
    const analysis = fakeAnalysis({ quality: { ...fakeAnalysis().quality, crossFlowRatio: 0.42 } });
    const measurement = {
      ...makeMeasurement('m-8', {
        method: 'video',
        surfaceVelocity: 1.2,
        depth: 0.31,
        sensorSnapshot: {
          timestamp: Date.now(),
          device: { appVersion: '1.0.7', algorithmVersion: 'ssiv-1.0.0' },
          camera: {
            available: true,
            facing: 'back' as const,
            intrinsicsAvailable: false,
            distortionAvailable: false,
            timingSource: 'WEBVIEW_MEDIA_TIME' as const,
          },
          motion: { accelerometerAvailable: false, gyroscopeAvailable: false, deviceMotionAvailable: false },
        },
      }),
      videoAnalysis: analysis,
    };
    const record = buildValidationRecord('v-8', measurement);
    expect(record.waterDepthM).toBe(0.31);
    expect(record.crossFlowRatio).toBeCloseTo(0.42, 9);
    expect(record.timingSource).toBe('WEBVIEW_MEDIA_TIME');
  });

  it('leaves crossFlowRatio and timingSource absent without a video analysis or sensor snapshot, but always carries the saved depth', () => {
    const measurement = makeMeasurement('m-9');
    const record = buildValidationRecord('v-9', measurement);
    // depth is a required field on every SavedMeasurement — always present.
    expect(record.waterDepthM).toBe(measurement.depth);
    expect(record.crossFlowRatio).toBeUndefined();
    expect(record.timingSource).toBeUndefined();
  });
});
