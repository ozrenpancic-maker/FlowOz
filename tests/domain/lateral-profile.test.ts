import {
  MIN_COLUMN_COVERAGE_FRACTION,
  integrateVelocityAreaDischarge,
  localDepth,
  type LateralVelocityColumn,
} from '../../domain/lateral-profile';
import { circularSection, rectangularSection, trapezoidalSection } from '../../domain/geometry';
import type { Dimensions } from '../../domain/types';

/**
 * Numerically integrates localDepth(u) du over [0,1] and scales by topWidth,
 * which must reconstruct the section's own area — this is the real check on
 * the by-hand derivation, independent of whichever algebra produced it.
 */
function numericArea(dimensions: Dimensions, depth: number, topWidth: number, samples = 20000): number {
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const u = (i + 0.5) / samples;
    const d = localDepth(dimensions, depth, u);
    sum += d ?? 0;
  }
  return (sum / samples) * topWidth;
}

describe('local depth profile', () => {
  it('rectangular: full depth at every lateral position', () => {
    const dims: Dimensions = { kind: 'rectangular', width: 2 };
    for (const u of [0, 0.1, 0.5, 0.9, 1]) {
      expect(localDepth(dims, 0.6, u)).toBeCloseTo(0.6, 9);
    }
    const section = rectangularSection(dims, 0.6);
    expect(section.ok).toBe(true);
    if (!section.ok) return;
    expect(numericArea(dims, 0.6, section.value.topWidth)).toBeCloseTo(section.value.area, 3);
  });

  it('trapezoidal: zero at both banks, full depth over the flat bed, reconstructs the true area', () => {
    const dims: Dimensions = {
      kind: 'trapezoidal',
      bottomWidth: 1,
      leftSlope: { mode: 'ratio', value: 1.5 },
      rightSlope: { mode: 'ratio', value: 0.5 },
    };
    const depth = 0.4;
    const section = trapezoidalSection(dims, depth);
    expect(section.ok).toBe(true);
    if (!section.ok) return;

    expect(localDepth(dims, depth, 0)).toBeCloseTo(0, 6);
    expect(localDepth(dims, depth, 1)).toBeCloseTo(0, 6);
    // The flat bed sits at u = zL·depth/topWidth .. (zL·depth+b)/topWidth.
    const bedStart = (1.5 * depth) / section.value.topWidth;
    const bedMid = bedStart + 0.5 / section.value.topWidth; // somewhere over b=1
    expect(localDepth(dims, depth, bedMid)).toBeCloseTo(depth, 6);

    expect(numericArea(dims, depth, section.value.topWidth)).toBeCloseTo(section.value.area, 3);
  });

  it('trapezoidal with a vertical wall on one side (slope 0) has no bank taper there', () => {
    const dims: Dimensions = {
      kind: 'trapezoidal',
      bottomWidth: 1,
      leftSlope: { mode: 'ratio', value: 0 },
      rightSlope: { mode: 'ratio', value: 1 },
    };
    const depth = 0.3;
    // At u=0 the left wall is vertical, so depth is full right up to the edge.
    expect(localDepth(dims, depth, 0)).toBeCloseTo(depth, 6);
    expect(localDepth(dims, depth, 1)).toBeCloseTo(0, 6);
  });

  it('circular: centre carries the full stated depth, both below and above half-full', () => {
    const dims: Dimensions = { kind: 'circular', diameter: 1 };
    for (const depth of [0.2, 0.5, 0.7, 0.9]) {
      expect(localDepth(dims, depth, 0.5)).toBeCloseTo(depth, 6);
    }
  });

  it('circular: reconstructs the true wetted area at or below half full', () => {
    const dims: Dimensions = { kind: 'circular', diameter: 1 };
    for (const depth of [0.1, 0.25, 0.5]) {
      const section = circularSection(dims, depth);
      expect(section.ok).toBe(true);
      if (!section.ok) continue;
      expect(numericArea(dims, depth, section.value.topWidth)).toBeCloseTo(section.value.area, 3);
    }
  });

  it('circular: understates the true area above half full — the visible surface no longer spans it', () => {
    // This is the mechanism integrateVelocityAreaDischarge refuses on
    // (CIRCULAR_MORE_THAN_HALF_FULL): part of the true wetted area is
    // submerged against the pipe wall, outside what a camera looking
    // straight down at the free surface can ever see.
    const dims: Dimensions = { kind: 'circular', diameter: 1 };
    for (const depth of [0.6, 0.75, 0.9]) {
      const section = circularSection(dims, depth);
      expect(section.ok).toBe(true);
      if (!section.ok) continue;
      expect(numericArea(dims, depth, section.value.topWidth)).toBeLessThan(section.value.area);
    }
  });

  it('circular: depth at the visible surface edge is only zero at or below half full', () => {
    // Above half full, the free surface's own edge is not the channel's true
    // edge — the water continues, submerged, around the pipe's widest point.
    // See domain/lateral-profile.ts's derivation for why this is correct.
    const dims: Dimensions = { kind: 'circular', diameter: 1 };
    expect(localDepth(dims, 0.4, 0)).toBeCloseTo(0, 6); // below half full: edge -> 0
    expect(localDepth(dims, 0.6, 0)).toBeGreaterThan(0.1); // above half full: edge stays deep
  });

  it('refuses an out-of-range u or a non-positive depth', () => {
    const dims: Dimensions = { kind: 'rectangular', width: 2 };
    expect(localDepth(dims, 0.5, -0.01)).toBeNull();
    expect(localDepth(dims, 0.5, 1.01)).toBeNull();
    expect(localDepth(dims, 0, 0.5)).toBeNull();
    expect(localDepth(dims, NaN, 0.5)).toBeNull();
  });
});

describe('velocity-area integration', () => {
  const dims: Dimensions = { kind: 'rectangular', width: 2 };
  const depth = 0.5;
  const section = rectangularSection(dims, depth);
  if (!section.ok) throw new Error('fixture section must be valid');

  const uniformColumns = (velocity: number, count: number): LateralVelocityColumn[] =>
    Array.from({ length: count }, (_, column) => ({
      column,
      u: (column + 0.5) / count,
      surfaceVelocityMs: velocity,
      sampleCount: 10,
    }));

  it('matches the single-point method when every column reports the same velocity', () => {
    // A uniform lateral profile is the case where the two methods must agree:
    // area · α · v equals the sum of equal strips each carrying α · v · depth.
    const alpha = 0.85;
    const v = 1.2;
    const columns = uniformColumns(v, 4);
    const result = integrateVelocityAreaDischarge(
      dims,
      depth,
      section.value.topWidth,
      section.value.area,
      columns,
      alpha,
      4
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flow).toBeCloseTo(section.value.area * alpha * v, 6);
    expect(result.value.columnsUsed).toBe(4);
  });

  it('gives a different, still sane answer for a genuinely non-uniform profile', () => {
    const alpha = 0.85;
    // Faster in the middle, slower at the banks — a realistic channel profile.
    const columns: LateralVelocityColumn[] = [
      { column: 0, u: 0.125, surfaceVelocityMs: 0.6, sampleCount: 5 },
      { column: 1, u: 0.375, surfaceVelocityMs: 1.2, sampleCount: 5 },
      { column: 2, u: 0.625, surfaceVelocityMs: 1.2, sampleCount: 5 },
      { column: 3, u: 0.875, surfaceVelocityMs: 0.6, sampleCount: 5 },
    ];
    const result = integrateVelocityAreaDischarge(
      dims,
      depth,
      section.value.topWidth,
      section.value.area,
      columns,
      alpha,
      4
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const uniform = section.value.area * alpha * 1.2;
    // Slower banks must pull the integrated total below the "everywhere as
    // fast as the centre" figure.
    expect(result.value.flow).toBeLessThan(uniform);
    expect(result.value.flow).toBeGreaterThan(0);
  });

  it('refuses to integrate when too few columns carry a velocity', () => {
    const alpha = 0.85;
    // 2 of 4 columns is below MIN_COLUMN_COVERAGE_FRACTION (0.75).
    expect(MIN_COLUMN_COVERAGE_FRACTION).toBeGreaterThan(0.5);
    const columns = uniformColumns(1, 2);
    const result = integrateVelocityAreaDischarge(
      dims,
      depth,
      section.value.topWidth,
      section.value.area,
      columns,
      alpha,
      4
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_COLUMN_COVERAGE');
  });

  it('refuses a circular pipe running more than half full', () => {
    const circular: Dimensions = { kind: 'circular', diameter: 1 };
    const depth = 0.6;
    const circularSectionResult = circularSection(circular, depth);
    expect(circularSectionResult.ok).toBe(true);
    if (!circularSectionResult.ok) return;
    const columns = uniformColumns(1, 4);
    const result = integrateVelocityAreaDischarge(
      circular,
      depth,
      circularSectionResult.value.topWidth,
      circularSectionResult.value.area,
      columns,
      0.85,
      4
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CIRCULAR_MORE_THAN_HALF_FULL');
  });

  it('accepts a circular pipe at or below half full', () => {
    const circular: Dimensions = { kind: 'circular', diameter: 1 };
    const depth = 0.5;
    const circularSectionResult = circularSection(circular, depth);
    expect(circularSectionResult.ok).toBe(true);
    if (!circularSectionResult.ok) return;
    const columns = uniformColumns(1, 4);
    const result = integrateVelocityAreaDischarge(
      circular,
      depth,
      circularSectionResult.value.topWidth,
      circularSectionResult.value.area,
      columns,
      0.85,
      4
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a non-positive alpha or an invalid section', () => {
    const columns = uniformColumns(1, 4);
    const badAlpha = integrateVelocityAreaDischarge(
      dims,
      depth,
      section.value.topWidth,
      section.value.area,
      columns,
      0,
      4
    );
    expect(badAlpha.ok).toBe(false);
    if (!badAlpha.ok) expect(badAlpha.error.code).toBe('INVALID_ALPHA');

    const badSection = integrateVelocityAreaDischarge(dims, depth, 0, section.value.area, columns, 0.85, 4);
    expect(badSection.ok).toBe(false);
    if (!badSection.ok) expect(badSection.error.code).toBe('INVALID_SECTION');
  });
});
