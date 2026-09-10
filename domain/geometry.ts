import type {
  CircularDimensions,
  Dimensions,
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
  | 'DEGENERATE_SECTION';

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
    default:
      return null;
  }
}
