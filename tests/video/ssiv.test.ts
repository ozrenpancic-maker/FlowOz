import { SSIV_FAILURE_CODES, isSsivFailure, ssivFailure } from '../../video/failure-taxonomy';
import { planFramePairs, processingSize } from '../../video/frame-plan';
import { interrogationGrid, analyse, robustDirection } from '../../video/ssiv-core';
import { estimateCameraMotion } from '../../video/stabilisation';
import { SSIV_THRESHOLDS } from '../../video/types';
import { makeClip, TEST_DIMENSIONS, TEST_ROI } from './synthetic';
import { median } from '../../domain/linalg';
import { lateralVelocityProfile } from '../../video/lateral-profile';

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

describe('flow direction', () => {
  it('does not flip direction when the flow runs leftward across the frame', () => {
    // Leftward flow sits on the ±π branch cut: half the vectors report an angle
    // just under +π and half just over −π. A median of those angles is 0, the
    // exact opposite direction, which would reject every vector as a
    // directional outlier.
    const dx = [-3, -3, -3, -3];
    const dy = [0.03, 0.015, -0.015, -0.03];
    const direction = robustDirection(dx, dy);
    expect(Math.abs(direction)).toBeCloseTo(Math.PI, 3);

    const naive = median(dx.map((value, i) => Math.atan2(dy[i] as number, value)));
    expect(Math.abs(naive)).toBeLessThan(0.1); // what the median of angles gives
  });

  it('reports the direction of the flow for each quadrant', () => {
    expect(robustDirection([3, 3], [0, 0])).toBeCloseTo(0, 6);
    expect(robustDirection([0, 0], [3, 3])).toBeCloseTo(Math.PI / 2, 6);
    expect(robustDirection([0, 0], [-3, -3])).toBeCloseTo(-Math.PI / 2, 6);
    expect(Number.isNaN(robustDirection([], []))).toBe(true);
  });

  it('reports a purely cross-stream displacement as no measurable discharge, not as a velocity', () => {
    // A displacement with no component along the ROI's downstream axis (world
    // Y, edge 1-2 towards edge 4-3) carries no water across the measurement
    // section — it must not be reported as if it were a real surface speed.
    for (const shiftX of [3, -3]) {
      const result = analyse({
        clip: makeClip({ shiftX, shiftY: 0 }),
        roi: TEST_ROI,
        knownDimensions: TEST_DIMENSIONS,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('uses only the streamwise component for surfaceVelocity, not the displacement magnitude', () => {
    // Across the flow: ROI is 0.4 · 240 px = 96 px ↔ 2 m, so a 4 px shift is
    // 4 · 2/96 = 0.0833 m, i.e. 0.8333 m/s — purely diagnostic (lateral).
    // Along the flow: ROI is 0.6 · 135 px = 81 px ↔ 3 m, so a 3 px shift is
    // 3 · 3/81 = 0.1111 m, i.e. 1.1111 m/s — this is what Q must be built on.
    const lateral = (4 * (TEST_DIMENSIONS.widthM / 96)) / 0.1;
    const streamwise = (3 * (TEST_DIMENSIONS.lengthM / 81)) / 0.1;
    const magnitude = Math.hypot(lateral, streamwise);

    const result = analyse({
      clip: makeClip({ shiftX: 4, shiftY: 3 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceVelocity).toBeCloseTo(streamwise, 1);
    expect(result.value.surfaceVelocity).not.toBeCloseTo(magnitude, 1);
    expect(result.value.quality.crossFlowRatio).toBeGreaterThan(SSIV_THRESHOLDS.crossFlowWarningRatio);

    const sampled = result.value.vectors.find((vector) => vector.accepted);
    expect(sampled?.lateralVelocityMs).toBeDefined();
    expect(Math.abs(sampled?.lateralVelocityMs ?? 0)).toBeGreaterThan(0);
  });

  it('reports an exact 45° diagonal displacement using only its streamwise half, not the full diagonal length', () => {
    // Equal shift on both axes: streamwise and lateral must come out equal in
    // magnitude too, and Q must be built from the smaller streamwise number,
    // not from the longer diagonal vector.
    const streamwise = (3 * (TEST_DIMENSIONS.lengthM / 81)) / 0.1;
    const lateral = (3 * (TEST_DIMENSIONS.widthM / 96)) / 0.1;
    const magnitude = Math.hypot(streamwise, lateral);

    const result = analyse({
      clip: makeClip({ shiftX: 3, shiftY: 3 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceVelocity).toBeCloseTo(streamwise, 1);
    expect(result.value.surfaceVelocity).toBeLessThan(magnitude);
  });

  it('rejects a reversed-relative-to-ROI flow by default, and recovers it once flowDirection is REVERSED', () => {
    // shiftY < 0 means the water moves against the ROI's own 1-2 -> 4-3
    // convention — a real situation when the operator drew the ROI with the
    // near/far edges swapped relative to the true flow.
    const reversedFlow = makeClip({ shiftX: 0, shiftY: -3 });

    const withoutOverride = analyse({ clip: reversedFlow, roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(withoutOverride.ok).toBe(false);

    const streamwise = (3 * (TEST_DIMENSIONS.lengthM / 81)) / 0.1;
    const corrected = analyse({
      clip: reversedFlow,
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
      flowDirection: 'REVERSED',
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.value.surfaceVelocity).toBeCloseTo(streamwise, 1);
    expect(corrected.value.surfaceVelocity).toBeGreaterThan(0);
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

  it('fits a small camera roll as a similarity instead of failing the pair', () => {
    // 2° of roll moves the frame corners by ~5 px in opposite directions, which
    // no single translation fits: the anchors would "disagree" and the pair
    // would be thrown away. A similarity fit takes the roll out.
    const clip = makeClip({ cameraRotationRad: (2 * Math.PI) / 180, shiftX: 0, shiftY: 0 });
    const motion = estimateCameraMotion(clip.pairs[0]!, TEST_ROI);
    expect(motion.stable).toBe(true);
    expect(motion.model).toBe('similarity');
    expect(motion.rotationRad).toBeCloseTo((2 * Math.PI) / 180, 2);
    expect(motion.scale).toBeCloseTo(1, 2);
    expect(motion.residualPx).toBeLessThan(1.5);
  });

  it('still measures the water correctly under a camera roll', () => {
    const rolled = analyse({
      clip: makeClip({ cameraRotationRad: (1.5 * Math.PI) / 180, shiftX: 0, shiftY: 3 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.value.surfaceVelocity).toBeCloseTo(EXPECTED_VELOCITY, 1);
    expect(rolled.value.stabilisation.every((entry) => entry.model === 'similarity')).toBe(true);
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

  it('resolves a fast displacement that would have exceeded the old, narrower search radius', () => {
    // 18px exceeds the pre-fix searchRadiusPx of 12 (see video/types.ts) —
    // this shift would previously have been rejected as SEARCH_WINDOW_EDGE
    // (or scored a weak correlation), leaving only near-zero noise vectors to
    // survive and reporting a falsely tiny velocity, exactly the field bug
    // that motivated widening the water-interrogation search radius to 24.
    const shiftY = 18;
    const result = analyse({ clip: makeClip({ shiftY }), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedVelocity = (shiftY * (TEST_DIMENSIONS.lengthM / 81)) / 0.1;
    expect(result.value.surfaceVelocity).toBeCloseTo(expectedVelocity, 1);
    expect(result.value.quality.acceptedVectors).toBeGreaterThanOrEqual(SSIV_THRESHOLDS.minAcceptedVectors);
    // No SEARCH_WINDOW_EDGE rejections — the true displacement now fits.
    expect(result.value.quality.rejectionsByReason.SEARCH_WINDOW_EDGE).toBe(0);
  });

  it('still stabilises the camera on a realistically tight ROI once the water search radius is widened', () => {
    // The water-interrogation and stabilisation-anchor searches must stay on
    // separate radii (SSIV_THRESHOLDS.searchRadiusPx vs
    // stabilisationSearchRadiusPx): sharing one would grow the anchor margin
    // along with the water radius and starve stabilisation of anchors on any
    // ROI that doesn't leave a huge background border — exactly TEST_ROI's
    // shape (60% of the frame width).
    const result = analyse({ clip: makeClip(), roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
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

describe('ensemble correlation', () => {
  it('agrees with the per-pair median rather than pulling away from it', () => {
    // Two independently-built estimates of the same water: if the ensemble's
    // raw-sum accumulation were wrong, this is the check most likely to catch
    // it — a real bug here (e.g. summing already-normalised ratios instead of
    // the raw terms, which was tried and produced no such improvement) tends
    // to show up as the two paths disagreeing, not just as noise.
    const result = analyse({
      clip: makeClip({ textureAmplitude: 0.15, noise: 5, pairs: 24 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.velocitySource).toBe('ensemble');
    expect(result.value.instantaneousVelocity).toBeDefined();
    expect(result.value.ensembleVelocity).toBeDefined();
    const ratio = (result.value.ensembleVelocity as number) / (result.value.instantaneousVelocity as number);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it('narrows around the true value as more pairs are averaged', () => {
    // What ensemble correlation actually buys, confirmed against the maths in
    // measureEnsemble's own comment: the expected correlation at the true
    // offset does not rise with the pair count (it is set by the surface's
    // own signal-to-noise ratio), but the *spread* of the estimate around
    // that value shrinks. A run with few pairs and a run with many, same
    // texture and noise otherwise, should bracket the true velocity more
    // tightly as pairs grow.
    const few = analyse({
      clip: makeClip({ textureAmplitude: 0.15, noise: 8, pairs: 6, seed: 4000 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    const many = analyse({
      clip: makeClip({ textureAmplitude: 0.15, noise: 8, pairs: 60, seed: 4000 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(few.ok && many.ok).toBe(true);
    if (!few.ok || !many.ok) return;
    expect(many.value.ensembleSpreadMs).toBeLessThan(few.value.ensembleSpreadMs as number);
  });

  it('never turns genuinely glassy water into a phantom zero-motion match', () => {
    // A pathologically wide filter could leak the static, textured bank
    // through a sharp bank/water edge and correlate it against itself at zero
    // displacement — a "flow" reading on a surface that carries nothing. The
    // image-quality pre-check now catches this before any correlation runs
    // at all (see the "failure taxonomy" tests below), which is a stronger
    // guarantee against the same phantom-match risk than reaching the
    // ensemble path and failing there.
    const result = analyse({
      clip: makeClip({ flatWater: true, pairs: 20 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_SURFACE_CONTRAST');
  });

  it('reports which frame pairs actually fed the ensemble', () => {
    const result = analyse({
      clip: makeClip({ pairs: 6 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quality.ensemblePairsUsed).toBeGreaterThan(0);
    expect(result.value.quality.ensembleNodes).toBe(SSIV_THRESHOLDS.gridColumns * SSIV_THRESHOLDS.gridRows);
    expect(result.value.ensemble.length).toBe(result.value.quality.ensembleNodes);
  });
});

describe('failure taxonomy', () => {
  it('exposes exactly the nine specified codes', () => {
    expect([...SSIV_FAILURE_CODES].sort()).toEqual(
      [
        'INSUFFICIENT_TEXTURE',
        'INSUFFICIENT_VALID_VECTORS',
        'INVALID_ROI_CALIBRATION',
        'UNSTABLE_CAMERA',
        'VIDEO_DECODE_FAILURE',
        'UNDEREXPOSED_VIDEO',
        'EXCESSIVE_GLARE',
        'INSUFFICIENT_SURFACE_CONTRAST',
        'MOTION_BLUR_TOO_HIGH',
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

  it('reports INSUFFICIENT SURFACE CONTRAST for glassy water with a sharp bank', () => {
    // The camera could be stabilised on the bank, but the image-quality
    // pre-check looks only at the ROI's own bounding box — the water itself
    // carries nothing to track — and refuses before spending any time on
    // stabilisation or correlation at all.
    const result = analyse({
      clip: makeClip({ flatWater: true }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_SURFACE_CONTRAST');
  });

  it('reports INSUFFICIENT SURFACE CONTRAST for a completely featureless frame', () => {
    // Nothing anywhere can be tracked; the cheap frame-statistics pre-check
    // now catches this before stabilisation is even attempted.
    const result = analyse({
      clip: makeClip({ flat: true }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_SURFACE_CONTRAST');
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
        expect(typeof vector.lateralVelocityMs).toBe('number');
        expect(typeof vector.speedMs).toBe('number');
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

describe('spatial coherence', () => {
  it('is judged against local grid neighbours, not the whole ROI — a real shear profile is not rejected as noise', () => {
    // Slower at both banks (columns 0 and 3), faster at the centre (columns 1
    // and 2): a completely ordinary channel velocity profile. A global-median
    // coherence check would read the edge columns as disagreeing with the
    // centre and reject them; a local check must not.
    const result = analyse({
      clip: makeClip({ shiftYByColumn: [1.5, 4, 4, 1.5], pairs: 8 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The shear itself must not be flagged as spatial noise.
    expect(result.value.quality.rejectionsByReason.SPATIAL_OUTLIER).toBe(0);

    const { columns } = lateralVelocityProfile(result.value);
    const byColumn = new Map(columns.map((c) => [c.column, c.surfaceVelocityMs]));
    const edge0 = byColumn.get(0) as number;
    const centre1 = byColumn.get(1) as number;
    const centre2 = byColumn.get(2) as number;
    const edge3 = byColumn.get(3) as number;
    expect(edge0).toBeDefined();
    expect(edge3).toBeDefined();
    // The real shear must survive into the reported per-column profile: the
    // banks read slower than the centre, not homogenised towards one value.
    expect(centre1).toBeGreaterThan(edge0);
    expect(centre2).toBeGreaterThan(edge3);
  });
});
