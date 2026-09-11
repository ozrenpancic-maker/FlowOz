import { estimateDepthFromRim, fitEllipse, type Point2D } from '../../domain/ellipse';
import { suggestInitialWaterLine, toEndpoints, type WaterLine } from '../../domain/water-line';

/** Points on a circle, evenly spaced in parametric angle (see ellipse.test.ts). */
function circlePoints(count: number, cx: number, cy: number, r: number): Point2D[] {
  const points: Point2D[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

describe('toEndpoints', () => {
  it('places the two endpoints symmetrically about the midpoint at the given angle and length', () => {
    const line: WaterLine = { midpoint: { x: 100, y: 50 }, angleRad: Math.PI / 4, halfLengthPx: 10 };
    const [p1, p2] = toEndpoints(line);
    // Midpoint of the two endpoints reproduces the line's own midpoint.
    expect((p1.x + p2.x) / 2).toBeCloseTo(100, 9);
    expect((p1.y + p2.y) / 2).toBeCloseTo(50, 9);
    // Each endpoint sits exactly halfLengthPx from the midpoint.
    expect(Math.hypot(p1.x - 100, p1.y - 50)).toBeCloseTo(10, 9);
    expect(Math.hypot(p2.x - 100, p2.y - 50)).toBeCloseTo(10, 9);
    // The two endpoints are collinear with the requested angle.
    expect(Math.atan2(p2.y - p1.y, p2.x - p1.x)).toBeCloseTo(Math.PI / 4, 9);
  });

  it('handles a horizontal line (angle 0)', () => {
    const [p1, p2] = toEndpoints({ midpoint: { x: 0, y: 0 }, angleRad: 0, halfLengthPx: 5 });
    expect(p1.x).toBeCloseTo(-5, 9);
    expect(p1.y).toBeCloseTo(0, 9);
    expect(p2.x).toBeCloseTo(5, 9);
    expect(p2.y).toBeCloseTo(0, 9);
  });
});

describe('geometric equivalence to the two-point model', () => {
  const fitResult = fitEllipse(circlePoints(12, 200, 150, 80));
  if (!fitResult.ok) throw new Error('fixture ellipse fit failed');
  const fit = fitResult.value;

  it('gives the same depth for the same midpoint/angle regardless of halfLengthPx', () => {
    const base: WaterLine = { midpoint: { x: 200, y: 190 }, angleRad: 0.15, halfLengthPx: 20 };
    const longer: WaterLine = { ...base, halfLengthPx: 60 };

    const shortEstimate = estimateDepthFromRim(fit, toEndpoints(base), 1);
    const longEstimate = estimateDepthFromRim(fit, toEndpoints(longer), 1);
    expect(shortEstimate.ok).toBe(true);
    expect(longEstimate.ok).toBe(true);
    if (!shortEstimate.ok || !longEstimate.ok) return;
    expect(longEstimate.value.depth).toBeCloseTo(shortEstimate.value.depth, 9);
    expect(longEstimate.value.fillRatio).toBeCloseTo(shortEstimate.value.fillRatio, 9);
  });

  it('matches an arbitrary, non-symmetric two-point waterline placed on the same line', () => {
    // The old UI let the operator tap any two points near the water surface —
    // not necessarily symmetric about any particular centre. As long as both
    // points lie on the same line, the averaged projection is identical.
    const angle = -0.2;
    const midpoint = { x: 205, y: 210 };
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const arbitraryTwoPoints: [Point2D, Point2D] = [
      { x: midpoint.x + dirX * 5, y: midpoint.y + dirY * 5 },
      { x: midpoint.x - dirX * 45, y: midpoint.y - dirY * 45 },
    ];
    // Symmetric line with the same *actual* midpoint of the two points above.
    const trueMidpoint = {
      x: (arbitraryTwoPoints[0].x + arbitraryTwoPoints[1].x) / 2,
      y: (arbitraryTwoPoints[0].y + arbitraryTwoPoints[1].y) / 2,
    };
    const line: WaterLine = { midpoint: trueMidpoint, angleRad: angle, halfLengthPx: 25 };

    const fromTwoPoints = estimateDepthFromRim(fit, arbitraryTwoPoints, 1);
    const fromLine = estimateDepthFromRim(fit, toEndpoints(line), 1);
    expect(fromTwoPoints.ok).toBe(true);
    expect(fromLine.ok).toBe(true);
    if (!fromTwoPoints.ok || !fromLine.ok) return;
    expect(fromLine.value.depth).toBeCloseTo(fromTwoPoints.value.depth, 9);
  });
});

describe('suggestInitialWaterLine', () => {
  const fit = { centre: { x: 50, y: 60 }, semiMajor: 40 };

  it('centres the line on the fitted rim', () => {
    const line = suggestInitialWaterLine(fit);
    expect(line.midpoint).toEqual({ x: 50, y: 60 });
    expect(line.halfLengthPx).toBeGreaterThan(40); // comfortably spans the rim
  });

  it('runs perpendicular to the gravity "down" vector', () => {
    const down = { x: 0.6, y: 0.8 };
    const line = suggestInitialWaterLine(fit, down);
    const direction = { x: Math.cos(line.angleRad), y: Math.sin(line.angleRad) };
    const dot = direction.x * down.x + direction.y * down.y;
    expect(dot).toBeCloseTo(0, 9);
  });

  it('defaults to image-horizontal when no gravity is available', () => {
    const line = suggestInitialWaterLine(fit);
    // No gravity => "down" defaults to +y, so the suggested line is horizontal.
    expect(Math.sin(line.angleRad)).toBeCloseTo(0, 9);
  });
});
