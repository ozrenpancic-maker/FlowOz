import {
  circularSection,
  computeSection,
  maximumDepth,
  rectangularSection,
  resolveSideSlope,
  trapezoidalSection,
} from '../../domain/geometry';
import {
  formatNumber,
  fromMetres,
  parseNumericInput,
  permilleToSlope,
  toMetres,
} from '../../domain/units';

describe('SI conversions', () => {
  it('converts every supported unit to metres', () => {
    expect(toMetres(250, 'mm')).toBeCloseTo(0.25, 12);
    expect(toMetres(25, 'cm')).toBeCloseTo(0.25, 12);
    expect(toMetres(0.25, 'm')).toBeCloseTo(0.25, 12);
  });

  it('round-trips through metres without drift', () => {
    for (const unit of ['mm', 'cm', 'm'] as const) {
      expect(fromMetres(toMetres(137.5, unit), unit)).toBeCloseTo(137.5, 9);
    }
  });

  it('converts a per-mille gradient to a dimensionless slope', () => {
    expect(permilleToSlope(5)).toBeCloseTo(0.005, 12);
    expect(permilleToSlope(0)).toBe(0);
  });

  it('accepts both decimal separators and rejects non-numbers', () => {
    expect(parseNumericInput('1,25')).toBeCloseTo(1.25, 12);
    expect(parseNumericInput('1.25')).toBeCloseTo(1.25, 12);
    expect(parseNumericInput('')).toBeNull();
    expect(parseNumericInput('abc')).toBeNull();
    expect(parseNumericInput('-')).toBeNull();
  });

  it('never formats a non-finite number as a digit', () => {
    expect(formatNumber(Number.NaN, 2)).toBe('—');
    expect(formatNumber(Number.POSITIVE_INFINITY, 2)).toBe('—');
    expect(formatNumber(null, 2)).toBe('—');
    expect(formatNumber(0, 2)).toBe('0.00');
  });
});

describe('circular section', () => {
  it('matches the closed form at half full', () => {
    const result = circularSection({ kind: 'circular', diameter: 1 }, 0.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Half a circle of radius 0.5: A = πr²/2, P = πr, T = D, Rh = r/2.
    expect(result.value.area).toBeCloseTo((Math.PI * 0.25) / 2, 9);
    expect(result.value.wettedPerimeter).toBeCloseTo(Math.PI * 0.5, 9);
    expect(result.value.topWidth).toBeCloseTo(1, 9);
    expect(result.value.hydraulicRadius).toBeCloseTo(0.25, 9);
    expect(result.value.fillRatio).toBeCloseTo(0.5, 12);
    expect(result.value.wettedAngle).toBeCloseTo(Math.PI, 9);
  });

  it('matches the closed form at quarter depth', () => {
    const D = 0.4;
    const h = 0.1;
    const result = circularSection({ kind: 'circular', diameter: D }, h);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = D / 2;
    const theta = 2 * Math.acos(1 - h / r);
    expect(result.value.area).toBeCloseTo((r * r * (theta - Math.sin(theta))) / 2, 12);
    expect(result.value.wettedPerimeter).toBeCloseTo(r * theta, 12);
    expect(result.value.topWidth).toBeCloseTo(2 * Math.sqrt(h * (D - h)), 12);
  });

  it('rejects both open-channel edge cases', () => {
    const empty = circularSection({ kind: 'circular', diameter: 0.5 }, 0);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('DEPTH_NOT_POSITIVE');

    const full = circularSection({ kind: 'circular', diameter: 0.5 }, 0.5);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error.code).toBe('PIPE_FULL_NOT_OPEN_CHANNEL');

    const over = circularSection({ kind: 'circular', diameter: 0.5 }, 0.9);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('DEPTH_EXCEEDS_SECTION');
  });

  it('rejects a non-positive diameter', () => {
    const result = circularSection({ kind: 'circular', diameter: 0 }, 0.1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NON_POSITIVE_DIMENSION');
  });
});

describe('rectangular section', () => {
  it('uses A = B·h, P = B + 2h, T = B', () => {
    const result = rectangularSection({ kind: 'rectangular', width: 2 }, 0.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.area).toBeCloseTo(1, 12);
    expect(result.value.wettedPerimeter).toBeCloseTo(3, 12);
    expect(result.value.topWidth).toBeCloseTo(2, 12);
    expect(result.value.hydraulicRadius).toBeCloseTo(1 / 3, 12);
  });

  it('rejects a depth above the stated total height', () => {
    const result = rectangularSection({ kind: 'rectangular', width: 2, totalHeight: 0.4 }, 0.5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DEPTH_EXCEEDS_SECTION');
  });
});

describe('trapezoidal section', () => {
  it('uses the specified area, perimeter and top width', () => {
    const result = trapezoidalSection(
      {
        kind: 'trapezoidal',
        bottomWidth: 1,
        leftSlope: { mode: 'ratio', value: 1.5 },
        rightSlope: { mode: 'ratio', value: 2 },
      },
      0.6
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const h = 0.6;
    const b = 1;
    const zL = 1.5;
    const zR = 2;
    expect(result.value.area).toBeCloseTo(h * (b + ((zL + zR) * h) / 2), 12);
    expect(result.value.wettedPerimeter).toBeCloseTo(
      b + h * Math.sqrt(1 + zL * zL) + h * Math.sqrt(1 + zR * zR),
      12
    );
    expect(result.value.topWidth).toBeCloseTo(b + h * (zL + zR), 12);
  });

  it('supports asymmetric sides', () => {
    const symmetric = trapezoidalSection(
      {
        kind: 'trapezoidal',
        bottomWidth: 1,
        leftSlope: { mode: 'ratio', value: 2 },
        rightSlope: { mode: 'ratio', value: 2 },
      },
      0.5
    );
    const asymmetric = trapezoidalSection(
      {
        kind: 'trapezoidal',
        bottomWidth: 1,
        leftSlope: { mode: 'ratio', value: 1 },
        rightSlope: { mode: 'ratio', value: 3 },
      },
      0.5
    );
    expect(symmetric.ok && asymmetric.ok).toBe(true);
    if (!symmetric.ok || !asymmetric.ok) return;
    // Same total z, so the same area, but different wetted perimeters.
    expect(asymmetric.value.area).toBeCloseTo(symmetric.value.area, 12);
    expect(asymmetric.value.wettedPerimeter).not.toBeCloseTo(symmetric.value.wettedPerimeter, 6);
  });

  describe('side slope input modes', () => {
    it('treats a 45° wall as z = 1 and a vertical wall as z = 0', () => {
      const fortyFive = resolveSideSlope({ mode: 'angle', degrees: 45 }, 1);
      expect(fortyFive.ok && fortyFive.value).toBeCloseTo(1, 9);

      const vertical = resolveSideSlope({ mode: 'angle', degrees: 90 }, 1);
      expect(vertical.ok && vertical.value).toBe(0);
    });

    it('derives z from a wetted side length', () => {
      // L = h·√(1+z²); for h = 1 and z = 1 that is √2.
      const result = resolveSideSlope({ mode: 'wettedLength', length: Math.SQRT2 }, 1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeCloseTo(1, 9);
    });

    it('rejects a wetted side shorter than the depth', () => {
      const result = resolveSideSlope({ mode: 'wettedLength', length: 0.5 }, 1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INVALID_SIDE_SLOPE');
    });

    it('rejects a negative ratio and a horizontal "wall"', () => {
      expect(resolveSideSlope({ mode: 'ratio', value: -1 }, 1).ok).toBe(false);
      expect(resolveSideSlope({ mode: 'angle', degrees: 0 }, 1).ok).toBe(false);
      expect(resolveSideSlope({ mode: 'angle', degrees: 120 }, 1).ok).toBe(false);
    });
  });
});

describe('section dispatch', () => {
  it('routes each geometry to its solver', () => {
    expect(computeSection({ kind: 'circular', diameter: 1 }, 0.5).ok).toBe(true);
    expect(computeSection({ kind: 'rectangular', width: 1 }, 0.5).ok).toBe(true);
    expect(
      computeSection(
        {
          kind: 'trapezoidal',
          bottomWidth: 1,
          leftSlope: { mode: 'ratio', value: 1 },
          rightSlope: { mode: 'ratio', value: 1 },
        },
        0.5
      ).ok
    ).toBe(true);
  });

  it('reports the maximum depth only where one exists', () => {
    expect(maximumDepth({ kind: 'circular', diameter: 0.8 })).toBe(0.8);
    expect(maximumDepth({ kind: 'rectangular', width: 1 })).toBeNull();
    expect(maximumDepth({ kind: 'rectangular', width: 1, totalHeight: 2 })).toBe(2);
  });
});
