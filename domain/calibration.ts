import { err, ok, type FailureBase, type Result } from './result';
import type { AlphaStatus, CalibrationPoint, ReferenceInstrument } from './types';
import { DEFAULT_ALPHA } from './types';
import { isPositiveFinite } from './units';
import { PLAUSIBILITY_RANGES } from './plausibility';

export type CalibrationErrorCode =
  | 'INVALID_AREA'
  | 'INVALID_SURFACE_VELOCITY'
  | 'INVALID_REFERENCE_FLOW'
  | 'ALPHA_OUT_OF_RANGE';

export interface CalibrationError extends FailureBase<CalibrationErrorCode> {
  field?: string;
}

function fail(code: CalibrationErrorCode, field?: string, detail?: string) {
  return err<CalibrationError>({ code, messageKey: `calibration.error.${code}`, field, detail });
}

export interface CalibrationInput {
  id: string;
  createdAt: string;
  depth: number;
  area: number;
  surfaceVelocity: number;
  referenceFlow: number;
  reference?: ReferenceInstrument;
  notes?: string;
}

/**
 * α = Qreference / (A · Vsurface)
 *
 * A point whose alpha falls outside the physically defensible band is stored
 * with `valid: false` and a reason, and is excluded from the active alpha — it
 * is evidence of a bad calibration run, not something to average in.
 */
export function deriveAlpha(input: CalibrationInput): Result<CalibrationPoint, CalibrationError> {
  if (!isPositiveFinite(input.area)) return fail('INVALID_AREA', 'area', `A=${input.area}`);
  if (!isPositiveFinite(input.surfaceVelocity)) {
    return fail('INVALID_SURFACE_VELOCITY', 'surfaceVelocity', `Vs=${input.surfaceVelocity}`);
  }
  if (!isPositiveFinite(input.referenceFlow)) {
    return fail('INVALID_REFERENCE_FLOW', 'referenceFlow', `Qref=${input.referenceFlow}`);
  }

  const alpha = input.referenceFlow / (input.area * input.surfaceVelocity);
  const range = PLAUSIBILITY_RANGES.alpha;
  const hardMin = range?.hardMin ?? 0.1;
  const hardMax = range?.hardMax ?? 2;
  const withinRange = Number.isFinite(alpha) && alpha >= hardMin && alpha <= hardMax;

  const point: CalibrationPoint = {
    id: input.id,
    createdAt: input.createdAt,
    depth: input.depth,
    area: input.area,
    surfaceVelocity: input.surfaceVelocity,
    referenceFlow: input.referenceFlow,
    alpha,
    valid: withinRange,
    ...(withinRange ? {} : { invalidReason: 'calibration.error.ALPHA_OUT_OF_RANGE' }),
    ...(input.reference ? { reference: input.reference } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };

  return ok(point);
}

export interface ActiveAlpha {
  alpha: number;
  status: AlphaStatus;
  /** Number of valid points behind the active alpha. */
  pointCount: number;
}

/**
 * The active alpha of a site: the mean of its valid calibration points, or the
 * documented default assumption when there are none. Invalid points can never
 * move the number.
 */
export function activeAlpha(points: readonly CalibrationPoint[]): ActiveAlpha {
  const valid = points.filter((point) => point.valid && isPositiveFinite(point.alpha));
  if (valid.length === 0) {
    return {
      alpha: DEFAULT_ALPHA,
      status: points.length > 0 ? 'calibrating' : 'default',
      pointCount: 0,
    };
  }
  const sum = valid.reduce((total, point) => total + point.alpha, 0);
  return { alpha: sum / valid.length, status: 'calibrated', pointCount: valid.length };
}
