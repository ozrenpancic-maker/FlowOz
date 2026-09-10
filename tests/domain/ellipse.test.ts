import {
  estimateDepthFromRim,
  fitEllipse,
  isNearlyCollinear,
  MIN_RIM_POINTS,
  type Point2D,
} from '../../domain/ellipse';

/** Points on a rotated ellipse, evenly spaced in parametric angle. */
function ellipsePoints(
  count: number,
  cx: number,
  cy: number,
  a: number,
  b: number,
  rotation = 0,
  jitter = 0
): Point2D[] {
  const points: Point2D[] = [];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count;
    const x = a * Math.cos(angle);
    const y = b * Math.sin(angle);
    points.push({
      x: cx + x * cos - y * sin + (jitter ? (((i * 7919) % 13) / 13 - 0.5) * jitter : 0),
      y: cy + x * sin + y * cos + (jitter ? (((i * 6271) % 11) / 11 - 0.5) * jitter : 0),
    });
  }
  return points;
}

describe('rim fit', () => {
  it('recovers the axes of a circle', () => {
    const result = fitEllipse(ellipsePoints(12, 200, 150, 90, 90));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.centre.x).toBeCloseTo(200, 3);
    expect(result.value.centre.y).toBeCloseTo(150, 3);
    expect(result.value.semiMajor).toBeCloseTo(90, 2);
    expect(result.value.semiMinor).toBeCloseTo(90, 2);
    expect(result.value.axisRatio).toBeCloseTo(1, 3);
  });

  it('recovers the axes of an axis-aligned ellipse', () => {
    const result = fitEllipse(ellipsePoints(12, 160, 120, 100, 55));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.semiMajor).toBeCloseTo(100, 2);
    expect(result.value.semiMinor).toBeCloseTo(55, 2);
    expect(result.value.centre.x).toBeCloseTo(160, 3);
  });

  it('recovers a rotated ellipse', () => {
    const rotation = Math.PI / 6;
    const result = fitEllipse(ellipsePoints(12, 180, 140, 110, 60, rotation));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.semiMajor).toBeCloseTo(110, 1);
    expect(result.value.semiMinor).toBeCloseTo(60, 1);
    // The major axis direction is defined modulo π.
    const recovered = ((result.value.rotation % Math.PI) + Math.PI) % Math.PI;
    expect(Math.min(Math.abs(recovered - rotation), Math.abs(recovered - rotation - Math.PI))).toBeLessThan(0.05);
  });

  it('stays close under small marking jitter', () => {
    const result = fitEllipse(ellipsePoints(12, 200, 150, 90, 60, 0, 2));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.semiMajor).toBeGreaterThan(85);
    expect(result.value.semiMajor).toBeLessThan(95);
    expect(result.value.residual).toBeLessThan(5);
  });

  it('drops a gross outlier instead of bending the fit around it', () => {
    const clean = ellipsePoints(12, 200, 150, 90, 60);
    const withOutlier = [...clean];
    withOutlier[3] = { x: 600, y: 600 }; // a badly misplaced tap

    const result = fitEllipse(withOutlier);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rejectedCount).toBeGreaterThan(0);
    expect(result.value.semiMajor).toBeCloseTo(90, 0);
    expect(result.value.semiMinor).toBeCloseTo(60, 0);
  });

  it('refuses fewer than eight points', () => {
    const result = fitEllipse(ellipsePoints(MIN_RIM_POINTS - 1, 200, 150, 90, 60));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TOO_FEW_POINTS');
  });

  it('refuses a collinear configuration rather than "fitting" it', () => {
    const line: Point2D[] = Array.from({ length: 10 }, (_, i) => ({ x: 10 * i, y: 20 + 0.001 * i }));
    expect(isNearlyCollinear(line)).toBe(true);

    const result = fitEllipse(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DEGENERATE_CONFIGURATION');
  });

  it('refuses non-finite points', () => {
    const points = ellipsePoints(10, 200, 150, 90, 60);
    points[2] = { x: Number.NaN, y: 0 };
    const result = fitEllipse(points);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DEGENERATE_CONFIGURATION');
  });
});

describe('depth from the fitted rim', () => {
  const fitCircle = () => {
    const result = fitEllipse(ellipsePoints(12, 200, 150, 100, 100));
    if (!result.ok) throw new Error('fixture fit failed');
    return result.value;
  };

  it('reads the fill ratio off a horizontal water line', () => {
    const fit = fitCircle();
    // A chord 50 px below the centre of a 100 px radius circle: 25 % full.
    const waterline: [Point2D, Point2D] = [
      { x: 140, y: 200 },
      { x: 260, y: 200 },
    ];
    const result = estimateDepthFromRim(fit, waterline, 0.4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fillRatio).toBeCloseTo(0.25, 2);
    expect(result.value.depth).toBeCloseTo(0.1, 2);
  });

  it('puts a water line through the centre at half full', () => {
    const result = estimateDepthFromRim(
      fitCircle(),
      [
        { x: 120, y: 150 },
        { x: 280, y: 150 },
      ],
      0.4
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fillRatio).toBeCloseTo(0.5, 3);
  });

  it('rejects a water line outside the rim instead of clamping it', () => {
    const result = estimateDepthFromRim(
      fitCircle(),
      [
        { x: 140, y: 400 },
        { x: 260, y: 400 },
      ],
      0.4
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WATERLINE_OUTSIDE_RIM');
  });

  it('never claims better than indicative confidence', () => {
    const result = estimateDepthFromRim(
      fitCircle(),
      [
        { x: 140, y: 200 },
        { x: 260, y: 200 },
      ],
      0.4
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(['INDICATIVE', 'WEAK']).toContain(result.value.confidence);
    expect(result.value.limitationKey).toBe('level.camera.affineModelLimitation');
  });

  it('downgrades an extremely oblique view to WEAK', () => {
    const oblique = fitEllipse(ellipsePoints(12, 200, 150, 200, 12));
    expect(oblique.ok).toBe(true);
    if (!oblique.ok) return;
    const result = estimateDepthFromRim(
      oblique.value,
      [
        { x: 150, y: 153 },
        { x: 250, y: 153 },
      ],
      0.4
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.confidence).toBe('WEAK');
  });

  it('reads the same depth from a rotated rim as from an upright one', () => {
    // The pipe is the same; only the phone is tilted. A rim fit that reported
    // the minor axis as its orientation would give a different depth here.
    const rotation = Math.PI / 5;
    const upright = fitEllipse(ellipsePoints(12, 0, 0, 100, 60));
    const tilted = fitEllipse(ellipsePoints(12, 0, 0, 100, 60, rotation));
    expect(upright.ok && tilted.ok).toBe(true);
    if (!upright.ok || !tilted.ok) return;

    // A water line 30 px "below" the centre, rotated with the rim.
    const rotate = (p: Point2D): Point2D => ({
      x: p.x * Math.cos(rotation) - p.y * Math.sin(rotation),
      y: p.x * Math.sin(rotation) + p.y * Math.cos(rotation),
    });
    const uprightLine: [Point2D, Point2D] = [
      { x: -40, y: 30 },
      { x: 40, y: 30 },
    ];
    const tiltedLine: [Point2D, Point2D] = [rotate(uprightLine[0]), rotate(uprightLine[1])];
    const gravity = { x: Math.sin(rotation) * -1, y: Math.cos(rotation) };

    const a = estimateDepthFromRim(upright.value, uprightLine, 0.4, { x: 0, y: 1 });
    const b = estimateDepthFromRim(tilted.value, tiltedLine, 0.4, gravity);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.value.fillRatio).toBeCloseTo(a.value.fillRatio, 2);
  });

  it('rejects a non-positive diameter', () => {
    const result = estimateDepthFromRim(
      fitCircle(),
      [
        { x: 140, y: 200 },
        { x: 260, y: 200 },
      ],
      0
    );
    expect(result.ok).toBe(false);
  });
});
