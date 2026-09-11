import type { Dimensions } from './types';
import { isPositiveFinite } from './units';
import { resolveSideSlope } from './geometry';
import { err, ok, type FailureBase, type Result } from './result';

/**
 * Discharge by velocity-area integration across a measured lateral surface-
 * velocity profile — the mid-section method (ISO 748) applied to a profile
 * that came from video instead of a wading rod.
 *
 * This is a cross-check on the single-point video result (area · α ·
 * median surface velocity), not a replacement for it: it rests on an
 * assumption the app cannot verify on its own — that the ROI the operator
 * drew spans the full water surface, bank to bank. `videoFlow` needs only a
 * representative velocity and makes no such claim about ROI framing, so it
 * stays the number that is saved and reported; this one is offered alongside
 * it, and a large disagreement between the two is itself useful information
 * about how the ROI was framed.
 *
 * A circular pipe running more than half full adds a second, sharper
 * limitation: a camera looking straight down can only ever see the narrow
 * top opening of the water, but the wetted cross-section is actually widest
 * at the pipe's own diameter, below the surface — a real slice of the true
 * area sits submerged against the pipe wall, outside anything visible from
 * above. Integrating only the visible strip then understates the true area
 * on a mechanism the video simply cannot correct for, so this case is
 * refused outright (CIRCULAR_MORE_THAN_HALF_FULL) rather than reported as if
 * it were a normal, if approximate, integration.
 */

export type LateralProfileErrorCode =
  | 'INVALID_SECTION'
  | 'INVALID_ALPHA'
  | 'INSUFFICIENT_COLUMN_COVERAGE'
  | 'NO_COLUMNS'
  | 'CIRCULAR_MORE_THAN_HALF_FULL';

export interface LateralProfileError extends FailureBase<LateralProfileErrorCode> {
  field?: string;
}

function fail(code: LateralProfileErrorCode, detail?: string): Result<never, LateralProfileError> {
  return err({ code, messageKey: `lateralProfile.error.${code}`, detail });
}

/** A minimum fraction of the interrogation columns must carry a velocity, or the
 * profile is refused rather than integrated as if the gaps carried no flow. */
export const MIN_COLUMN_COVERAGE_FRACTION = 0.75;

/**
 * Local water depth [m] at a normalised lateral position `u` ∈ [0, 1] across
 * the *current* water surface — u = 0 at one edge, u = 1 at the other, in the
 * same left-to-right sense as the ROI columns (column 0 nearest `topLeft`).
 *
 * Returns null for an invalid section or a `u` outside [0, 1].
 */
export function localDepth(dimensions: Dimensions, depth: number, u: number): number | null {
  if (!isPositiveFinite(depth) || !Number.isFinite(u) || u < 0 || u > 1) return null;

  switch (dimensions.kind) {
    case 'rectangular': {
      // Vertical walls: the water column is the full depth everywhere.
      if (!isPositiveFinite(dimensions.width)) return null;
      return depth;
    }

    case 'circular': {
      const D = dimensions.diameter;
      if (!isPositiveFinite(D) || depth >= D) return null;
      const r = D / 2;
      const halfWidth = Math.sqrt(Math.max(0, depth * (D - depth)));
      if (halfWidth <= 0) return null;
      // x measured from the pipe's own centre, not the chord's — the chord is
      // already centred on the pipe axis for a circular section.
      const x = -halfWidth + u * (2 * halfWidth);
      const waterSurfaceY = depth - r;
      const localHalfChord = Math.sqrt(Math.max(0, r * r - x * x));
      // Valid at any fill level as the depth directly under a point of the
      // *visible* free surface — but see integrateVelocityAreaDischarge for
      // why more than half full makes that surface the wrong thing to
      // integrate over.
      return Math.max(0, waterSurfaceY + localHalfChord);
    }

    case 'trapezoidal': {
      const b = dimensions.bottomWidth;
      if (!Number.isFinite(b) || b < 0) return null;
      const left = resolveSideSlope(dimensions.leftSlope, depth);
      const right = resolveSideSlope(dimensions.rightSlope, depth);
      if (!left.ok || !right.ok) return null;
      const zL = left.value;
      const zR = right.value;
      const topWidth = b + depth * (zL + zR);
      if (!isPositiveFinite(topWidth)) return null;

      // x = 0 at the bottom-left corner (where the left bank meets the flat
      // bed), x = b at the bottom-right corner; the water surface spans from
      // x = -zL·depth to x = b + zR·depth.
      const x = -zL * depth + u * topWidth;
      if (x < 0) {
        // Over the left bank: depth falls linearly to 0 at the water's edge.
        return zL > 0 ? Math.max(0, depth + x / zL) : 0;
      }
      if (x > b) {
        return zR > 0 ? Math.max(0, depth - (x - b) / zR) : 0;
      }
      return depth; // over the flat bed
    }

    default: {
      const exhaustive: never = dimensions;
      void exhaustive;
      return null;
    }
  }
}

/** One column of a measured lateral surface-velocity profile. */
export interface LateralVelocityColumn {
  /** Column index, 0-based, matching the SSIV interrogation grid. */
  column: number;
  /** Normalised lateral position of the column centre, (column + 0.5) / totalColumns. */
  u: number;
  /** Representative surface velocity of the column [m/s]. */
  surfaceVelocityMs: number;
  /** Interrogation nodes or vectors behind this column's figure. */
  sampleCount: number;
}

export interface VelocityAreaResult {
  /** Discharge by velocity-area integration [m³/s]. */
  flow: number;
  /** Q / area, for comparison with the single-point method's mean velocity. */
  meanVelocity: number;
  columnsUsed: number;
  columnsTotal: number;
}

/**
 * Integrate discharge across the lateral profile: for each column, a strip of
 * the water surface of width `topWidth / columnsTotal` centred on that
 * column, alpha applied to its own surface velocity and depth taken at its
 * own lateral position — so a shallow, slow edge column and a deep, fast
 * centre column each contribute what they actually carry, rather than one
 * velocity being spread over the whole section.
 *
 * `topWidth` and `area` are the section's own — the caller already has them
 * from `computeSection` for this depth, and re-deriving them here from the
 * geometry a second time would be one more place for the two to drift apart.
 *
 * Refuses rather than integrates when too few columns carry a velocity
 * (`MIN_COLUMN_COVERAGE_FRACTION`): a missing column is not known to carry
 * zero flow, and treating it as such would understate the discharge exactly
 * where the profile is thinnest — usually the banks, where slower water can
 * still fail the correlation filters even where the centre passes easily.
 */
export function integrateVelocityAreaDischarge(
  dimensions: Dimensions,
  depth: number,
  topWidth: number,
  area: number,
  columns: readonly LateralVelocityColumn[],
  alpha: number,
  columnsTotal: number
): Result<VelocityAreaResult, LateralProfileError> {
  if (!isPositiveFinite(alpha)) return fail('INVALID_ALPHA', `alpha=${alpha}`);
  if (!isPositiveFinite(topWidth) || !isPositiveFinite(area)) {
    return fail('INVALID_SECTION', `topWidth=${topWidth}, area=${area}`);
  }
  if (!Number.isInteger(columnsTotal) || columnsTotal <= 0) {
    return fail('NO_COLUMNS', `columnsTotal=${columnsTotal}`);
  }
  if (dimensions.kind === 'circular' && depth > dimensions.diameter / 2) {
    return fail(
      'CIRCULAR_MORE_THAN_HALF_FULL',
      `depth=${depth} > D/2=${dimensions.diameter / 2}; the visible surface no longer spans the true wetted width`
    );
  }

  const coverage = columns.length / columnsTotal;
  if (coverage < MIN_COLUMN_COVERAGE_FRACTION) {
    return fail(
      'INSUFFICIENT_COLUMN_COVERAGE',
      `${columns.length}/${columnsTotal} columns carried a velocity, ` +
        `${Math.ceil(MIN_COLUMN_COVERAGE_FRACTION * columnsTotal)} required`
    );
  }

  const stripWidth = topWidth / columnsTotal;
  let flow = 0;
  for (const entry of columns) {
    const depthHere = localDepth(dimensions, depth, entry.u);
    if (depthHere === null) return fail('INVALID_SECTION', `u=${entry.u}`);
    flow += alpha * entry.surfaceVelocityMs * depthHere * stripWidth;
  }

  if (!Number.isFinite(flow) || flow <= 0) return fail('INVALID_SECTION', `Q=${flow}`);

  return ok({
    flow,
    meanVelocity: flow / area,
    columnsUsed: columns.length,
    columnsTotal,
  });
}
