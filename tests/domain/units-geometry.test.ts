import {
  circularSection,
  computeSection,
  irregularSection,
  maximumDepth,
  MIN_IRREGULAR_STATIONS,
  rectangularSection,
  resolveSideSlope,
  stationAreas,
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

describe('irregular section (field survey, mid-section method)', () => {
  it('reproduces a rectangle: uniform depth, evenly spaced stations', () => {
    // A flat, level bed 2 m wide, 0.4 m deep, five equally spaced stations.
    // The mid-section method should recover exactly what rectangularSection
    // would give a true rectangle — the two are the same shape read two ways.
    const result = irregularSection({
      kind: 'irregular',
      stations: [
        { distanceM: 0, depthM: 0.4 },
        { distanceM: 0.5, depthM: 0.4 },
        { distanceM: 1.0, depthM: 0.4 },
        { distanceM: 1.5, depthM: 0.4 },
        { distanceM: 2.0, depthM: 0.4 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.area).toBeCloseTo(2 * 0.4, 9);
    expect(result.value.topWidth).toBeCloseTo(2, 9);
    // Perimeter here is only the survey's own polyline — flat, so it equals
    // the top width, not the U-shape a real rectangular channel would add at
    // the walls; see the wetted-perimeter simplification in the function's
    // own comment for why the two are not expected to agree in general.
    expect(result.value.wettedPerimeter).toBeCloseTo(2, 9);
  });

  it('reproduces a symmetric triangle: matches a trapezoid with zero bottom width', () => {
    // A V-shaped bed, 0.6 m deep at the centre of a 2.4 m top width, surveyed
    // at three stations, against the equivalent trapezoid (b=0, z=2 both
    // sides) computed the closed-form way.
    const trapezoid = trapezoidalSection(
      {
        kind: 'trapezoidal',
        bottomWidth: 0,
        leftSlope: { mode: 'ratio', value: 2 },
        rightSlope: { mode: 'ratio', value: 2 },
      },
      0.6
    );
    const survey = irregularSection({
      kind: 'irregular',
      stations: [
        { distanceM: 0, depthM: 0 },
        { distanceM: 1.2, depthM: 0.6 },
        { distanceM: 2.4, depthM: 0 },
      ],
    });
    expect(trapezoid.ok && survey.ok).toBe(true);
    if (!trapezoid.ok || !survey.ok) return;
    expect(survey.value.area).toBeCloseTo(trapezoid.value.area, 9);
    expect(survey.value.topWidth).toBeCloseTo(trapezoid.value.topWidth, 9);
    expect(survey.value.wettedPerimeter).toBeCloseTo(trapezoid.value.wettedPerimeter, 9);
  });

  it('handles uneven spacing exactly — an extra station at a ledge changes nothing else', () => {
    // Same overall shape as the rectangle above, but with one extra station
    // dropped in close to the left bank (a rock, in the field). Its own panel
    // is narrower; everyone else's panels adjust to match, and the total area
    // is unchanged because the depth either side of the extra station is the
    // same uniform depth.
    const even = irregularSection({
      kind: 'irregular',
      stations: [
        { distanceM: 0, depthM: 0.4 },
        { distanceM: 1.0, depthM: 0.4 },
        { distanceM: 2.0, depthM: 0.4 },
      ],
    });
    const uneven = irregularSection({
      kind: 'irregular',
      stations: [
        { distanceM: 0, depthM: 0.4 },
        { distanceM: 0.1, depthM: 0.4 }, // the extra station, close to the bank
        { distanceM: 1.0, depthM: 0.4 },
        { distanceM: 2.0, depthM: 0.4 },
      ],
    });
    expect(even.ok && uneven.ok).toBe(true);
    if (!even.ok || !uneven.ok) return;
    expect(uneven.value.area).toBeCloseTo(even.value.area, 9);
    expect(uneven.value.topWidth).toBeCloseTo(even.value.topWidth, 9);
  });

  it('refuses fewer than the minimum stations', () => {
    const result = irregularSection({
      kind: 'irregular',
      stations: [
        { distanceM: 0, depthM: 0 },
        { distanceM: 1, depthM: 0.3 },
      ],
    });
    expect(MIN_IRREGULAR_STATIONS).toBeGreaterThan(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TOO_FEW_STATIONS');
  });

  it('refuses stations out of order or repeated', () => {
    const result = irregularSection({
      kind: 'irregular',
      stations: [
        { distanceM: 0, depthM: 0 },
        { distanceM: 1, depthM: 0.3 },
        { distanceM: 1, depthM: 0.2 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('STATIONS_NOT_ORDERED');
  });

  it('refuses a negative depth', () => {
    const result = irregularSection({
      kind: 'irregular',
      stations: [
        { distanceM: 0, depthM: 0 },
        { distanceM: 1, depthM: -0.1 },
        { distanceM: 2, depthM: 0 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NEGATIVE_STATION_DEPTH');
  });

  it('refuses a degenerate survey with no area', () => {
    const result = irregularSection({
      kind: 'irregular',
      stations: [
        { distanceM: 0, depthM: 0 },
        { distanceM: 1, depthM: 0 },
        { distanceM: 2, depthM: 0 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('DEGENERATE_SECTION');
  });

  it('dispatches through computeSection, ignoring the external depth argument', () => {
    const stations = [
      { distanceM: 0, depthM: 0 },
      { distanceM: 0.6, depthM: 0.2 },
      { distanceM: 1.2, depthM: 0 },
    ];
    const direct = irregularSection({ kind: 'irregular', stations });
    // Any depth value dispatches to the same result: the survey is what
    // decides the section, not this argument.
    const viaDispatch = computeSection({ kind: 'irregular', stations }, 999);
    expect(direct.ok && viaDispatch.ok).toBe(true);
    if (!direct.ok || !viaDispatch.ok) return;
    expect(viaDispatch.value).toEqual(direct.value);
  });

  it('has no maximum depth other than its own deepest station', () => {
    const stations = [
      { distanceM: 0, depthM: 0 },
      { distanceM: 0.6, depthM: 0.35 },
      { distanceM: 1.2, depthM: 0.1 },
    ];
    expect(maximumDepth({ kind: 'irregular', stations })).toBeCloseTo(0.35, 9);
    expect(maximumDepth({ kind: 'irregular', stations: [] })).toBeNull();
  });

  describe('stationAreas', () => {
    it('sums to the same total irregularSection reports', () => {
      const stations = [
        { distanceM: 0, depthM: 0 },
        { distanceM: 0.3, depthM: 0.25 },
        { distanceM: 0.9, depthM: 0.4 },
        { distanceM: 1.1, depthM: 0.15 },
        { distanceM: 1.4, depthM: 0 },
      ];
      const areas = stationAreas(stations);
      const total = irregularSection({ kind: 'irregular', stations });
      expect(total.ok).toBe(true);
      if (!total.ok) return;
      expect(areas.reduce((sum, value) => sum + value, 0)).toBeCloseTo(total.value.area, 9);
      expect(areas).toHaveLength(stations.length);
    });

    it('gives the edge stations only their inward half-panel', () => {
      const areas = stationAreas([
        { distanceM: 0, depthM: 1 },
        { distanceM: 1, depthM: 1 },
        { distanceM: 2, depthM: 1 },
      ]);
      expect(areas[0]).toBeCloseTo(0.5, 9); // half-panel only, to the right
      expect(areas[1]).toBeCloseTo(1, 9); // full panel, half on each side
      expect(areas[2]).toBeCloseTo(0.5, 9); // half-panel only, to the left
    });
  });
});
