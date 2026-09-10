import { SSIV_FAILURE_CODES, isSsivFailure, ssivFailure } from '../../video/failure-taxonomy';
import { planFramePairs, processingSize } from '../../video/frame-plan';
import { interrogationGrid, analyse } from '../../video/ssiv-core';
import { estimateCameraMotion } from '../../video/stabilisation';
import { SSIV_THRESHOLDS } from '../../video/types';
import { makeClip, TEST_DIMENSIONS, TEST_ROI } from './synthetic';

/**
 * The synthetic clip translates the texture inside the ROI by a known number of
 * pixels while the background stays put, so the expected surface velocity is
 * exactly computable:
 *
 *   ROI height  = 0.6 · 135 px = 81 px  ↔ 3 m along the flow
 *   shift       = 3 px                  → 3 · 3/81 m = 0.1111 m
 *   frame delta = 0.1 s                 → 1.1111 m/s
 */
const EXPECTED_VELOCITY = (3 * (TEST_DIMENSIONS.lengthM / 81)) / 0.1;

describe('frame sampling plan', () => {
  it('produces the configured number of pairs inside the delta band', () => {
    const plan = planFramePairs(5);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.pairs).toHaveLength(SSIV_THRESHOLDS.framePairs);
    for (const pair of plan.pairs) {
      expect(pair.frameDeltaS).toBeGreaterThanOrEqual(SSIV_THRESHOLDS.minFrameDeltaS);
      expect(pair.frameDeltaS).toBeLessThanOrEqual(SSIV_THRESHOLDS.maxFrameDeltaS);
      expect(pair.secondS).toBeGreaterThan(pair.firstS);
      expect(pair.secondS).toBeLessThanOrEqual(5);
    }
  });

  it('spreads the pairs over the clip rather than bunching them', () => {
    const plan = planFramePairs(10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const first = plan.pairs[0];
    const last = plan.pairs[plan.pairs.length - 1];
    expect(last!.firstS - first!.firstS).toBeGreaterThan(5);
  });

  it('refuses a clip that is too short to hold a pair', () => {
    const plan = planFramePairs(0.05);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error.code).toBe('CLIP_TOO_SHORT');
  });

  it('refuses a non-finite duration', () => {
    expect(planFramePairs(Number.NaN).ok).toBe(false);
    expect(planFramePairs(0).ok).toBe(false);
  });

  it('downscales to the working width and never upscales', () => {
    expect(processingSize(1280, 720)).toEqual({ width: 240, height: 135 });
    expect(processingSize(160, 120)).toEqual({ width: 160, height: 120 });
    expect(processingSize(0, 720)).toBeNull();
  });
});

describe('interrogation grid', () => {
  it('places 4 × 5 points inside the ROI', () => {
    const grid = interrogationGrid(TEST_ROI);
    expect(grid).toHaveLength(SSIV_THRESHOLDS.gridColumns * SSIV_THRESHOLDS.gridRows);
    for (const node of grid) {
      expect(node.point.x).toBeGreaterThan(TEST_ROI.topLeft.x);
      expect(node.point.x).toBeLessThan(TEST_ROI.topRight.x);
      expect(node.point.y).toBeGreaterThan(TEST_ROI.topLeft.y);
      expect(node.point.y).toBeLessThan(TEST_ROI.bottomLeft.y);
    }
  });
});

describe('camera motion compensation', () => {
  it('reports a stationary background as stable with no shift', () => {
    const clip = makeClip();
    const pair = clip.pairs[0]!;
    const motion = estimateCameraMotion(pair, TEST_ROI);
    expect(motion.stable).toBe(true);
    expect(Math.hypot(motion.shiftXPx, motion.shiftYPx)).toBeLessThan(0.5);
    expect(motion.correlation).toBeGreaterThanOrEqual(SSIV_THRESHOLDS.minStabilisationCorrelation);
  });

  it('reports a non-rigidly warped frame as unstable', () => {
    // Anchors that each track well but disagree about the shift are not a
    // global camera motion, and must not be passed off as one.
    const clip = makeClip({ shakyBackground: true });
    const motion = estimateCameraMotion(clip.pairs[0]!, TEST_ROI);
    expect(motion.stable).toBe(false);
  });

  it('measures a genuine rigid pan and subtracts it', () => {
    // The whole frame moves together: still stable, with a non-zero shift.
    const clip = makeClip({ moving: { x0: 0, x1: 239, y0: 0, y1: 134 }, shiftX: 2, shiftY: 0 });
    const motion = estimateCameraMotion(clip.pairs[0]!, TEST_ROI);
    expect(motion.stable).toBe(true);
    expect(motion.shiftXPx).toBeCloseTo(2, 1);
    expect(Math.abs(motion.shiftYPx)).toBeLessThan(0.5);
  });
});

describe('SSIV analysis of a known displacement', () => {
  it('recovers the surface velocity from a synthetic clip', () => {
    const result = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.surfaceVelocity).toBeCloseTo(EXPECTED_VELOCITY, 2);
    expect(result.value.calibrationStatus).toBe('VALID');
    expect(result.value.quality.acceptedVectors).toBeGreaterThanOrEqual(
      SSIV_THRESHOLDS.minAcceptedVectors
    );
    expect(result.value.quality.stablePairs).toBeGreaterThanOrEqual(SSIV_THRESHOLDS.minStablePairs);
  });

  it('is repeatable — the same clip gives exactly the same number', () => {
    const first = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    const second = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.surfaceVelocity).toBe(first.value.surfaceVelocity);
    expect(second.value.quality.acceptedVectors).toBe(first.value.quality.acceptedVectors);
  });

  it('scales with the frame delta', () => {
    const slow = analyse({
      clip: makeClip({ frameDeltaS: 0.16 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    const fast = analyse({
      clip: makeClip({ frameDeltaS: 0.08 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(slow.ok && fast.ok).toBe(true);
    if (!slow.ok || !fast.ok) return;
    expect(fast.value.surfaceVelocity / slow.value.surfaceVelocity).toBeCloseTo(2, 1);
  });

  it('scales with the stated physical ROI length', () => {
    const short = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    const long = analyse({
      clip: makeClip(),
      roi: TEST_ROI,
      knownDimensions: { widthM: 2, lengthM: 6 },
    });
    expect(short.ok && long.ok).toBe(true);
    if (!short.ok || !long.ok) return;
    expect(long.value.surfaceVelocity / short.value.surfaceVelocity).toBeCloseTo(2, 1);
  });

  it('survives moderate sensor noise', () => {
    const result = analyse({
      clip: makeClip({ noise: 6 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceVelocity).toBeCloseTo(EXPECTED_VELOCITY, 1);
  });
});

describe('failure taxonomy', () => {
  it('exposes exactly the five specified codes', () => {
    expect([...SSIV_FAILURE_CODES].sort()).toEqual(
      [
        'INSUFFICIENT_TEXTURE',
        'INSUFFICIENT_VALID_VECTORS',
        'INVALID_ROI_CALIBRATION',
        'UNSTABLE_CAMERA',
        'VIDEO_DECODE_FAILURE',
      ].sort()
    );
  });

  it('gives every failure a message key and a corrective action', () => {
    for (const code of SSIV_FAILURE_CODES) {
      const failure = ssivFailure(code, 'detail');
      expect(failure.messageKey).toBe(`ssiv.error.${code}`);
      expect(failure.actionKey).toBe(`ssiv.action.${code}`);
      expect(failure.detail).toBe('detail');
      expect(isSsivFailure(failure)).toBe(true);
    }
    expect(isSsivFailure({ code: 'SOMETHING_ELSE' })).toBe(false);
  });

  it('reports INSUFFICIENT TEXTURE for glassy water with a sharp bank', () => {
    // The camera can be stabilised on the bank; it is the water that carries
    // nothing to track, which is exactly what this message tells the operator.
    const result = analyse({
      clip: makeClip({ flatWater: true }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_TEXTURE');
  });

  it('reports UNSTABLE CAMERA for a completely featureless frame', () => {
    // Nothing anywhere can be tracked, so stabilisation is what fails first.
    const result = analyse({
      clip: makeClip({ flat: true }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNSTABLE_CAMERA');
  });

  it('reports UNSTABLE CAMERA when the background cannot be tracked', () => {
    const result = analyse({
      clip: makeClip({ shakyBackground: true }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNSTABLE_CAMERA');
      expect(result.error.evidence?.stablePairs).toBeLessThan(SSIV_THRESHOLDS.minStablePairs);
    }
  });

  it('reports INVALID ROI CALIBRATION before doing any correlation work', () => {
    const result = analyse({
      clip: makeClip(),
      roi: TEST_ROI,
      knownDimensions: { widthM: 0, lengthM: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ROI_CALIBRATION');
  });

  it('reports VIDEO DECODE FAILURE for an empty or malformed clip', () => {
    const empty = analyse({
      clip: { sourceWidth: 1280, sourceHeight: 720, width: 240, height: 135, durationS: 5, pairs: [] },
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('VIDEO_DECODE_FAILURE');

    const clip = makeClip();
    const truncated = {
      ...clip,
      pairs: clip.pairs.map((pair) => ({ ...pair, first: new Float32Array(10) })),
    };
    const malformed = analyse({ clip: truncated, roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('VIDEO_DECODE_FAILURE');
  });

  it('never reports a withheld velocity as zero', () => {
    const result = analyse({
      clip: makeClip({ flatWater: true }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(false);
    // There is no `surfaceVelocity: 0` anywhere in a failed result.
    expect(result).not.toHaveProperty('value');
  });
});

describe('raw vector metadata contract', () => {
  it('keeps every metric for every vector, accepted or not', () => {
    const result = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.vectors.length).toBeGreaterThan(0);
    for (const vector of result.value.vectors) {
      expect(typeof vector.pairIndex).toBe('number');
      expect(typeof vector.gridColumn).toBe('number');
      expect(typeof vector.gridRow).toBe('number');
      expect(typeof vector.x).toBe('number');
      expect(typeof vector.y).toBe('number');
      expect(typeof vector.correlation).toBe('number');
      expect(typeof vector.peakRatio).toBe('number');
      expect(typeof vector.snr).toBe('number');
      expect(typeof vector.uncertaintyPx).toBe('number');
      expect(typeof vector.forwardBackwardPx).toBe('number');
      expect(typeof vector.spatialCoherence).toBe('number');
      expect(typeof vector.accepted).toBe('boolean');

      if (vector.accepted) {
        // An accepted vector carries its metric conversion.
        expect(typeof vector.velocityMs).toBe('number');
        expect(typeof vector.displacementM).toBe('number');
        expect(vector.rejectionReason).toBeUndefined();
      } else {
        // A rejected vector always states why.
        expect(vector.rejectionReason).toBeDefined();
      }
    }
  });

  it('reports the thresholds it ran with, for later audit', () => {
    const result = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.thresholds.minCorrelation).toBe(0.55);
    expect(result.value.thresholds.minPeakRatio).toBe(1.015);
    expect(result.value.thresholds.maxUncertaintyPx).toBe(20);
    expect(result.value.thresholds.maxForwardBackwardPx).toBe(1.5);
    expect(result.value.thresholds.minSpatialCoherence).toBe(0.25);
    expect(result.value.thresholds.minAcceptedVectors).toBe(4);
    expect(result.value.thresholds.minStabilisationCorrelation).toBe(0.55);
    expect(result.value.thresholds.minStablePairs).toBe(3);
    expect(result.value.algorithmVersion).toBeTruthy();
    expect(result.value.analysedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accounts for every vector in the quality summary', () => {
    const result = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { quality, vectors } = result.value;
    expect(quality.totalVectors).toBe(vectors.length);
    expect(quality.acceptedVectors + quality.rejectedVectors).toBe(quality.totalVectors);
    expect(quality.acceptanceRatio).toBeCloseTo(quality.acceptedVectors / quality.totalVectors, 12);

    const countedRejections = Object.values(quality.rejectionsByReason).reduce((a, b) => a + b, 0);
    expect(countedRejections).toBe(quality.rejectedVectors);
  });

  it('records a stabilisation entry for every sampled pair', () => {
    const result = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stabilisation).toHaveLength(result.value.sampledPairs);
  });
});
