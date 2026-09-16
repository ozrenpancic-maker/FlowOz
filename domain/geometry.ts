import type {
  CircularDimensions,
  CrossSectionStation,
  Dimensions,
  IrregularDimensions,
  RectangularDimensions,
  SectionProperties,
  SideSlopeInput,
  TrapezoidalDimensions,
} from './types';
import { err, ok, type FailureBase, type Result } from './result';
import { isPositiveFinite } from './units';

export type GeometryErrorCode =
  | 'NON_FINITE_INPUT'
  | 'NON_POSITIVE_DIMENSION'
  | 'DEPTH_NOT_POSITIVE'
  | 'DEPTH_EXCEEDS_SECTION'
  | 'PIPE_FULL_NOT_OPEN_CHANNEL'
  | 'INVALID_SIDE_SLOPE'
  | 'DEGENERATE_SECTION'
  | 'TOO_FEW_STATIONS'
  | 'STATIONS_NOT_ORDERED'
  | 'NEGATIVE_STATION_DEPTH';

export interface GeometryError extends FailureBase<GeometryErrorCode> {
  /** Which field the operator has to correct. */
  field?: string;
}

function fail(code: GeometryErrorCode, field?: string, detail?: string): Result<never, GeometryError> {
  return err({ code, messageKey: `geometry.error.${code}`, field, detail });
}

/**
 * Resolve a side slope to the dimensionless z (horizontal run per unit of
 * depth). A vertical wall is z = 0.
 */
export function resolveSideSlope(input: SideSlopeInput, depth: number): Result<number, GeometryError> {
  switch (input.mode) {
    case 'ratio': {
      if (!Number.isFinite(input.value) || input.value < 0) {
        return fail('INVALID_SIDE_SLOPE', 'sideSlope', `ratio=${input.value}`);
      }
      return ok(input.value);
    }
    case 'angle': {
      const deg = input.degrees;
      // 0° would be a horizontal "wall" — an infinitely wide section.
      if (!Number.isFinite(deg) || deg <= 0 || deg > 90) {
        return fail('INVALID_SIDE_SLOPE', 'sideSlope', `angle=${deg}`);
      }
      const z = 1 / Math.tan((deg * Math.PI) / 180);
      // tan(90°) is not exactly infinite in floating point; clamp the vertical case.
      return ok(Math.abs(z) < 1e-12 ? 0 : z);
    }
    case 'wettedLength': {
      const L = input.length;
      if (!isPositiveFinite(L) || !isPositiveFinite(depth)) {
        return fail('INVALID_SIDE_SLOPE', 'sideSlope', `wettedLength=${L}, depth=${depth}`);
      }
      if (L < depth) {
        // A wetted side shorter than the depth is geometrically impossible.
        return fail('INVALID_SIDE_SLOPE', 'sideSlope', `wettedLength ${L} < depth ${depth}`);
      }
      const ratio = L / depth;
      return ok(Math.sqrt(Math.max(0, ratio * ratio - 1)));
    }
    default:
      return fail('INVALID_SIDE_SLOPE', 'sideSlope');
  }
}

/**
 * Circular pipe running partly full.
 *
 * θ = 2·arccos(1 − h/r), A = r²(θ − sin θ)/2, P = r·θ, T = 2√(h(D − h)).
 * Both edge cases (empty, completely full) are rejected: neither is open-channel
 * flow and Manning would be meaningless there.
 */
export function circularSection(
  dimensions: CircularDimensions,
  depth: number
): Result<SectionProperties, GeometryError> {
  const D = dimensions.diameter;
  if (!isPositiveFinite(D)) return fail('NON_POSITIVE_DIMENSION', 'diameter', `D=${D}`);
  if (!Number.isFinite(depth)) return fail('NON_FINITE_INPUT', 'depth', `h=${depth}`);
  if (depth <= 0) return fail('DEPTH_NOT_POSITIVE', 'depth', `h=${depth}`);
  if (depth >= D) {
    return depth === D || depth / D < 1 + 1e-9
      ? fail('PIPE_FULL_NOT_OPEN_CHANNEL', 'depth', `h=${depth}, D=${D}`)
      : fail('DEPTH_EXCEEDS_SECTION', 'depth', `h=${depth}, D=${D}`);
  }

  const r = D / 2;
  // Guard the arccos argument against floating point drift outside [-1, 1].
  const cosArg = Math.min(1, Math.max(-1, 1 - depth / r));
  const theta = 2 * Math.acos(cosArg);
  const area = (r * r * (theta - Math.sin(theta))) / 2;
  const wettedPerimeter = r * theta;
  const topWidth = 2 * Math.sqrt(Math.max(0, depth * (D - depth)));

  if (!isPositiveFinite(area) || !isPositiveFinite(wettedPerimeter)) {
    return fail('DEGENERATE_SECTION', 'depth', `A=${area}, P=${wettedPerimeter}`);
  }

  return ok({
    area,
    wettedPerimeter,
    topWidth,
    hydraulicRadius: area / wettedPerimeter,
    fillRatio: depth / D,
    wettedAngle: theta,
  });
}

/** Rectangular channel: A = B·h, P = B + 2h, T = B. */
export function rectangularSection(
  dimensions: RectangularDimensions,
  depth: number
): Result<SectionProperties, GeometryError> {
  const B = dimensions.width;
  if (!isPositiveFinite(B)) return fail('NON_POSITIVE_DIMENSION', 'width', `B=${B}`);
  if (!Number.isFinite(depth)) return fail('NON_FINITE_INPUT', 'depth', `h=${depth}`);
  if (depth <= 0) return fail('DEPTH_NOT_POSITIVE', 'depth', `h=${depth}`);
  if (isPositiveFinite(dimensions.totalHeight) && depth > dimensions.totalHeight) {
    return fail('DEPTH_EXCEEDS_SECTION', 'depth', `h=${depth}, H=${dimensions.totalHeight}`);
  }

  const area = B * depth;
  const wettedPerimeter = B + 2 * depth;

  return ok({
    area,
    wettedPerimeter,
    topWidth: B,
    hydraulicRadius: area / wettedPerimeter,
  });
}

/**
 * Trapezoidal channel with independent left and right side slopes.
 *
 * A = h·[b + (zL + zR)h/2]
 * P = b + h√(1 + zL²) + h√(1 + zR²)
 * T = b + h(zL + zR)
 */
export function trapezoidalSection(
  dimensions: TrapezoidalDimensions,
  depth: number
): Result<SectionProperties, GeometryError> {
  const b = dimensions.bottomWidth;
  if (!Number.isFinite(b) || b < 0) return fail('NON_POSITIVE_DIMENSION', 'bottomWidth', `b=${b}`);
  if (!Number.isFinite(depth)) return fail('NON_FINITE_INPUT', 'depth', `h=${depth}`);
  if (depth <= 0) return fail('DEPTH_NOT_POSITIVE', 'depth', `h=${depth}`);

  const left = resolveSideSlope(dimensions.leftSlope, depth);
  if (!left.ok) return left;
  const right = resolveSideSlope(dimensions.rightSlope, depth);
  if (!right.ok) return right;

  const zL = left.value;
  const zR = right.value;

  const area = depth * (b + ((zL + zR) * depth) / 2);
  const wettedPerimeter =
    b + depth * Math.sqrt(1 + zL * zL) + depth * Math.sqrt(1 + zR * zR);
  const topWidth = b + depth * (zL + zR);

  // A zero bottom width with vertical sides collapses the section entirely.
  if (!isPositiveFinite(area) || !isPositiveFinite(wettedPerimeter)) {
    return fail('DEGENERATE_SECTION', 'bottomWidth', `A=${area}, P=${wettedPerimeter}`);
  }

  return ok({
    area,
    wettedPerimeter,
    topWidth,
    hydraulicRadius: area / wettedPerimeter,
  });
}

/** Fewer than this cannot describe a shape — see {@link irregularSection}. */
export const MIN_IRREGULAR_STATIONS = 3;

/**
 * Wetted section from a field survey of depths across the channel, by the
 * mid-section method (ISO 748 / USGS gauging practice): each station's own
 * depth is applied across half the distance to its neighbour on either side.
 *
 *   Ai = di · ((xi − xi-1)/2 + (xi+1 − xi)/2)
 *
 * with the half missing at each end, so the two edge stations — normally the
 * waterline at each bank, depth 0 — contribute only the half-panel reaching
 * inward. Uneven spacing is handled exactly, not as a special case: a station
 * added at a rock or a ledge simply gets its own, narrower panel, which is
 * the whole point of allowing arbitrary station positions instead of a fixed
 * interval.
 *
 * Wetted perimeter sums the slant distance between consecutive stations. A
 * bank station with non-zero depth (a vertical wall the water sits flush
 * against, rather than a taper to the waterline) under-states the true
 * perimeter by whatever vertical wall lies above that station and was not
 * surveyed — a known simplification, and one that does not affect the
 * video-based discharge at all, since that path uses area alone.
 */
export function irregularSection(
  dimensions: IrregularDimensions
): Result<SectionProperties, GeometryError> {
  const stations = dimensions.stations;
  if (stations.length < MIN_IRREGULAR_STATIONS) {
    return fail(
      'TOO_FEW_STATIONS',
      'stations',
      `${stations.length} < ${MIN_IRREGULAR_STATIONS}`
    );
  }
  for (const station of stations) {
    if (!Number.isFinite(station.distanceM) || !Number.isFinite(station.depthM)) {
      return fail(
        'NON_FINITE_INPUT',
        'stations',
        `x=${station.distanceM}, h=${station.depthM}`
      );
    }
    if (station.depthM < 0) {
      return fail(
        'NEGATIVE_STATION_DEPTH',
        'stations',
        `h=${station.depthM} at x=${station.distanceM}`
      );
    }
  }
  for (let i = 1; i < stations.length; i += 1) {
    const previous = stations[i - 1] as CrossSectionStation;
    const current = stations[i] as CrossSectionStation;
    if (current.distanceM <= previous.distanceM) {
      return fail(
        'STATIONS_NOT_ORDERED',
        'stations',
        `x[${i}]=${current.distanceM} <= x[${i - 1}]=${previous.distanceM}`
      );
    }
  }

  const areas = stationAreas(stations);
  const area = areas.reduce((sum, value) => sum + value, 0);

  let wettedPerimeter = 0;
  for (let i = 1; i < stations.length; i += 1) {
    const previous = stations[i - 1] as CrossSectionStation;
    const current = stations[i] as CrossSectionStation;
    wettedPerimeter += Math.hypot(
      current.distanceM - previous.distanceM,
      current.depthM - previous.depthM
    );
  }

  const first = stations[0] as CrossSectionStation;
  const last = stations[stations.length - 1] as CrossSectionStation;
  const topWidth = last.distanceM - first.distanceM;

  if (!isPositiveFinite(area) || !isPositiveFinite(topWidth)) {
    return fail('DEGENERATE_SECTION', 'stations', `A=${area}, T=${topWidth}`);
  }

  return ok({
    area,
    wettedPerimeter,
    topWidth,
    hydraulicRadius: area / wettedPerimeter,
  });
}

/**
 * Each station's own share of the mid-section area, in survey order — the
 * breakdown `irregularSection` sums, exposed separately so the operator can
 * be shown which single station is carrying too much of the section while
 * they are still placing them, rather than only after the fact.
 *
 * No validation here: called from a live editor where the stations are
 * mid-edit and may briefly be out of order or too few. `irregularSection`
 * is where an actual calculation enforces the real constraints.
 */
export function stationAreas(stations: readonly CrossSectionStation[]): number[] {
  return stations.map((station, i) => {
    const previous = stations[i - 1];
    const next = stations[i + 1];
    const leftHalf = previous ? (station.distanceM - previous.distanceM) / 2 : 0;
    const rightHalf = next ? (next.distanceM - station.distanceM) / 2 : 0;
    const width = leftHalf + rightHalf;
    return Number.isFinite(width) && width > 0 ? station.depthM * width : 0;
  });
}

/** Dispatch to the section solver that matches the geometry. */
export function computeSection(
  dimensions: Dimensions,
  depth: number
): Result<SectionProperties, GeometryError> {
  switch (dimensions.kind) {
    case 'circular':
      return circularSection(dimensions, depth);
    case 'rectangular':
      return rectangularSection(dimensions, depth);
    case 'trapezoidal':
      return trapezoidalSection(dimensions, depth);
    case 'irregular':
      // depth is unused here: each station already carries its own, and
      // there is no separate scalar to combine them with — see
      // IrregularDimensions's own comment.
      return irregularSection(dimensions);
    default: {
      const exhaustive: never = dimensions;
      return fail('DEGENERATE_SECTION', undefined, JSON.stringify(exhaustive));
    }
  }
}

/** Largest depth the section can physically carry, when one exists. */
export function maximumDepth(dimensions: Dimensions): number | null {
  switch (dimensions.kind) {
    case 'circular':
      return dimensions.diameter;
    case 'rectangular':
      return isPositiveFinite(dimensions.totalHeight) ? dimensions.totalHeight : null;
    case 'trapezoidal':
      return null;
    case 'irregular':
      return dimensions.stations.length > 0
        ? Math.max(...dimensions.stations.map((station) => station.depthM))
        : null;
    default:
      return null;
  }
}
