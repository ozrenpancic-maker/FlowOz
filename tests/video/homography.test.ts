import type { WaterRoi } from '../../domain/types';
import {
  applyHomography,
  buildCalibration,
  metricDisplacement,
  solveHomography,
  translateRoi,
} from '../../video/homography';
import { defaultRoi, edgeLengths, isSelfIntersecting, signedArea, validateRoi } from '../../video/roi';
import { SSIV_THRESHOLDS } from '../../video/types';

const FRAME_W = 240;
const FRAME_H = 135;

const rectangleRoi: WaterRoi = {
  topLeft: { x: 0.2, y: 0.2 },
  topRight: { x: 0.8, y: 0.2 },
  bottomRight: { x: 0.8, y: 0.8 },
  bottomLeft: { x: 0.2, y: 0.8 },
};

const dimensions = { widthM: 2, lengthM: 3 };

describe('ROI validation', () => {
  it('accepts a well-formed ROI', () => {
    expect(validateRoi(rectangleRoi, dimensions)).toHaveLength(0);
    expect(validateRoi(defaultRoi(), dimensions)).toHaveLength(0);
  });

  it('rejects a point outside the frame', () => {
    const roi: WaterRoi = { ...rectangleRoi, topRight: { x: 1.4, y: 0.2 } };
    expect(validateRoi(roi, dimensions).map((p) => p.code)).toContain('POINT_OUTSIDE_FRAME');
  });

  it('rejects a non-finite point and stops there', () => {
    const roi: WaterRoi = { ...rectangleRoi, topLeft: { x: Number.NaN, y: 0.2 } };
    const problems = validateRoi(roi, dimensions);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('NON_FINITE_POINT');
  });

  it('rejects a self-intersecting "bow tie"', () => {
    const roi: WaterRoi = {
      topLeft: { x: 0.2, y: 0.2 },
      topRight: { x: 0.8, y: 0.2 },
      bottomRight: { x: 0.2, y: 0.8 },
      bottomLeft: { x: 0.8, y: 0.8 },
    };
    expect(isSelfIntersecting(roi)).toBe(true);
    expect(validateRoi(roi, dimensions).map((p) => p.code)).toContain('SELF_INTERSECTING');
  });

  it('rejects an ROI whose corners are wound the wrong way', () => {
    const roi: WaterRoi = {
      topLeft: { x: 0.8, y: 0.2 },
      topRight: { x: 0.2, y: 0.2 },
      bottomRight: { x: 0.2, y: 0.8 },
      bottomLeft: { x: 0.8, y: 0.8 },
    };
    expect(signedArea(roi)).toBeLessThan(0);
    expect(validateRoi(roi, dimensions).map((p) => p.code)).toContain('WRONG_WINDING');
  });

  it('rejects an ROI below the minimum area fraction', () => {
    const roi: WaterRoi = {
      topLeft: { x: 0.5, y: 0.5 },
      topRight: { x: 0.55, y: 0.5 },
      bottomRight: { x: 0.55, y: 0.55 },
      bottomLeft: { x: 0.5, y: 0.55 },
    };
    expect(Math.abs(signedArea(roi))).toBeLessThan(SSIV_THRESHOLDS.minRoiAreaFraction);
    expect(validateRoi(roi, dimensions).map((p) => p.code)).toContain('AREA_TOO_SMALL');
  });

  it('rejects an extremely elongated ROI', () => {
    const roi: WaterRoi = {
      topLeft: { x: 0.02, y: 0.45 },
      topRight: { x: 0.98, y: 0.45 },
      bottomRight: { x: 0.98, y: 0.5 },
      bottomLeft: { x: 0.02, y: 0.5 },
    };
    const codes = validateRoi(roi, dimensions).map((p) => p.code);
    expect(codes).toContain('EXTREME_EDGE_RATIO');
  });

  it('rejects non-positive physical dimensions — there is no pixel fallback', () => {
    const codes = validateRoi(rectangleRoi, { widthM: 0, lengthM: 3 }).map((p) => p.code);
    expect(codes).toContain('NON_POSITIVE_PHYSICAL_DIMENSION');
  });

  it('measures the four edges', () => {
    expect(edgeLengths(rectangleRoi)).toHaveLength(4);
  });
});

describe('homography', () => {
  it('maps the ROI corners onto the stated physical rectangle', () => {
    const result = buildCalibration(rectangleRoi, dimensions, FRAME_W, FRAME_H);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('VALID');

    const topLeft = applyHomography(result.value.forward, 0.2 * FRAME_W, 0.2 * FRAME_H);
    const bottomRight = applyHomography(result.value.forward, 0.8 * FRAME_W, 0.8 * FRAME_H);
    expect(topLeft?.x).toBeCloseTo(0, 6);
    expect(topLeft?.y).toBeCloseTo(0, 6);
    expect(bottomRight?.x).toBeCloseTo(2, 6);
    expect(bottomRight?.y).toBeCloseTo(3, 6);
  });

  it('passes the numerical closure check', () => {
    const result = buildCalibration(rectangleRoi, dimensions, FRAME_W, FRAME_H);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.numericalClosureErrorPx).toBeLessThan(0.05);
      expect(Number.isFinite(result.value.determinant)).toBe(true);
      expect(Math.abs(result.value.determinant)).toBeGreaterThan(0);
    }
  });

  it('handles a genuinely perspective ROI', () => {
    // A trapezoid: the far bank is narrower in the image than the near bank.
    const perspective: WaterRoi = {
      topLeft: { x: 0.35, y: 0.25 },
      topRight: { x: 0.65, y: 0.25 },
      bottomRight: { x: 0.85, y: 0.8 },
      bottomLeft: { x: 0.15, y: 0.8 },
    };
    const result = buildCalibration(perspective, dimensions, FRAME_W, FRAME_H);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The same pixel displacement is worth more metres far away than near.
    const near = metricDisplacement(result.value, 0.5 * FRAME_W, 0.78 * FRAME_H, 0, 2);
    const far = metricDisplacement(result.value, 0.5 * FRAME_W, 0.27 * FRAME_H, 0, 2);
    expect(near && far).toBeTruthy();
    if (!near || !far) return;
    expect(far.distanceM).toBeGreaterThan(near.distanceM);
  });

  it('refuses to build without a physical scale', () => {
    const result = buildCalibration(rectangleRoi, { widthM: 0, lengthM: 3 }, FRAME_W, FRAME_H);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('ROI_INVALID');
      expect(result.error.problems.map((p) => p.code)).toContain('NON_POSITIVE_PHYSICAL_DIMENSION');
    }
  });

  it('refuses a self-intersecting ROI', () => {
    const roi: WaterRoi = {
      topLeft: { x: 0.2, y: 0.2 },
      topRight: { x: 0.8, y: 0.2 },
      bottomRight: { x: 0.2, y: 0.8 },
      bottomLeft: { x: 0.8, y: 0.8 },
    };
    const result = buildCalibration(roi, dimensions, FRAME_W, FRAME_H);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ROI_INVALID');
  });

  it('refuses a degenerate ROI where three corners are collinear', () => {
    const roi: WaterRoi = {
      topLeft: { x: 0.2, y: 0.2 },
      topRight: { x: 0.5, y: 0.2 },
      bottomRight: { x: 0.8, y: 0.2 },
      bottomLeft: { x: 0.2, y: 0.8 },
    };
    const result = buildCalibration(roi, dimensions, FRAME_W, FRAME_H);
    expect(result.ok).toBe(false);
  });

  it('refuses a frame with no dimensions', () => {
    const result = buildCalibration(rectangleRoi, dimensions, 0, FRAME_H);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNSOLVABLE');
  });

  it('returns null for four coincident source points instead of a bogus map', () => {
    const same = [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ];
    expect(solveHomography(same, same)).toBeNull();
  });

  it('rejects a point at infinity', () => {
    // A projective map whose last row sends the point to w = 0.
    expect(applyHomography([1, 0, 0, 0, 1, 0, 1, 0, -1], 1, 0)).toBeNull();
  });

  it('converts pixel displacement to metres at both ends of the vector', () => {
    const result = buildCalibration(rectangleRoi, dimensions, FRAME_W, FRAME_H);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The ROI spans 0.6·135 = 81 px for 3 m, so 27 px is 1 m.
    const metric = metricDisplacement(result.value, 0.5 * FRAME_W, 0.5 * FRAME_H, 0, 27);
    expect(metric?.distanceM).toBeCloseTo(1, 6);
    expect(metric?.dyM).toBeCloseTo(1, 6);
    expect(metric?.dxM).toBeCloseTo(0, 9);
  });
});

describe('translateRoi', () => {
  it('shifts the ROI downstream by exactly the requested distance, keeping width', () => {
    const moved = translateRoi(rectangleRoi, dimensions, FRAME_W, FRAME_H, 0, 0.5);
    expect(moved).not.toBeNull();
    if (!moved) return;
    // 1 m along the flow is 27 px = 0.2 of the 135 px frame height.
    expect(moved.topLeft.y).toBeCloseTo(0.2 + 0.1, 6);
    expect(moved.bottomLeft.y).toBeCloseTo(0.8 + 0.1, 6);
    expect(moved.topLeft.x).toBeCloseTo(rectangleRoi.topLeft.x, 6);
    expect(moved.bottomRight.x).toBeCloseTo(rectangleRoi.bottomRight.x, 6);
  });

  it('shifts across the flow, keeping length', () => {
    const moved = translateRoi(rectangleRoi, dimensions, FRAME_W, FRAME_H, 0.5, 0);
    expect(moved).not.toBeNull();
    if (!moved) return;
    // 1 m across is 72 px = 0.3 of the 240 px frame width.
    expect(moved.topLeft.x).toBeCloseTo(0.2 + 0.15, 6);
    expect(moved.topRight.x).toBeCloseTo(0.8 + 0.15, 6);
    expect(moved.topLeft.y).toBeCloseTo(rectangleRoi.topLeft.y, 6);
  });

  it('produces a rectangle whose recalibration reproduces the same width/length', () => {
    const moved = translateRoi(rectangleRoi, dimensions, FRAME_W, FRAME_H, 0.3, -0.4);
    expect(moved).not.toBeNull();
    if (!moved) return;
    const recalibrated = buildCalibration(moved, dimensions, FRAME_W, FRAME_H);
    expect(recalibrated.ok).toBe(true);
    if (!recalibrated.ok) return;
    expect(recalibrated.value.status).toBe('VALID');

    const topLeftPx = { x: moved.topLeft.x * FRAME_W, y: moved.topLeft.y * FRAME_H };
    const topRightPx = { x: moved.topRight.x * FRAME_W, y: moved.topRight.y * FRAME_H };
    const bottomLeftPx = { x: moved.bottomLeft.x * FRAME_W, y: moved.bottomLeft.y * FRAME_H };
    const width = metricDisplacement(
      recalibrated.value,
      topLeftPx.x,
      topLeftPx.y,
      topRightPx.x - topLeftPx.x,
      topRightPx.y - topLeftPx.y
    );
    const length = metricDisplacement(
      recalibrated.value,
      topLeftPx.x,
      topLeftPx.y,
      bottomLeftPx.x - topLeftPx.x,
      bottomLeftPx.y - topLeftPx.y
    );
    expect(width?.distanceM).toBeCloseTo(dimensions.widthM, 6);
    expect(length?.distanceM).toBeCloseTo(dimensions.lengthM, 6);
  });

  it('returns null without a valid current calibration — nothing to move within', () => {
    expect(translateRoi(rectangleRoi, { widthM: 0, lengthM: 3 }, FRAME_W, FRAME_H, 0.1, 0)).toBeNull();
  });

  it('leaves the ROI unchanged for a zero-distance move', () => {
    const moved = translateRoi(rectangleRoi, dimensions, FRAME_W, FRAME_H, 0, 0);
    expect(moved).not.toBeNull();
    if (!moved) return;
    for (const key of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const) {
      expect(moved[key].x).toBeCloseTo(rectangleRoi[key].x, 6);
      expect(moved[key].y).toBeCloseTo(rectangleRoi[key].y, 6);
    }
  });

  it('does not hide a move that lands outside the visible frame', () => {
    const moved = translateRoi(rectangleRoi, dimensions, FRAME_W, FRAME_H, 0, 5);
    expect(moved).not.toBeNull();
    if (!moved) return;
    expect(validateRoi(moved, dimensions).map((p) => p.code)).toContain('POINT_OUTSIDE_FRAME');
  });
});
