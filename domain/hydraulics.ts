import { err, ok, type FailureBase, type Result } from './result';
import type { SectionProperties } from './types';
import { isPositiveFinite, permilleToSlope } from './units';

export type HydraulicsErrorCode =
  | 'INVALID_SECTION'
  | 'INVALID_ROUGHNESS'
  | 'INVALID_SLOPE'
  | 'INVALID_VELOCITY'
  | 'INVALID_ALPHA'
  | 'NON_FINITE_RESULT';

export interface HydraulicsError extends FailureBase<HydraulicsErrorCode> {
  field?: string;
}

function fail(
  code: HydraulicsErrorCode,
  field?: string,
  detail?: string
): Result<never, HydraulicsError> {
  return err({ code, messageKey: `hydraulics.error.${code}`, field, detail });
}

export interface ManningResult {
  /** Mean velocity V [m/s]. */
  velocity: number;
  /** Discharge Q [m³/s]. */
  flow: number;
  /** Dimensionless slope actually used. */
  slope: number;
  roughness: number;
}

/**
 * Manning's equation.
 *
 * V = (1/n)·Rh^(2/3)·S^(1/2),  Q = A·V
 *
 * The operator enters the gradient in ‰; it is converted to the dimensionless S
 * here so that no screen has to remember the conversion.
 */
export function manningVelocity(
  section: SectionProperties,
  roughness: number,
  slopePermille: number
): Result<ManningResult, HydraulicsError> {
  if (!isPositiveFinite(section.hydraulicRadius) || !isPositiveFinite(section.area)) {
    return fail('INVALID_SECTION', undefined, `Rh=${section.hydraulicRadius}, A=${section.area}`);
  }
  if (!isPositiveFinite(roughness)) return fail('INVALID_ROUGHNESS', 'roughness', `n=${roughness}`);
  if (!Number.isFinite(slopePermille)) return fail('INVALID_SLOPE', 'slope', `S‰=${slopePermille}`);

  const slope = permilleToSlope(slopePermille);
  if (!isPositiveFinite(slope)) return fail('INVALID_SLOPE', 'slope', `S=${slope}`);

  const velocity = (1 / roughness) * Math.pow(section.hydraulicRadius, 2 / 3) * Math.sqrt(slope);
  const flow = section.area * velocity;

  if (!Number.isFinite(velocity) || !Number.isFinite(flow)) {
    return fail('NON_FINITE_RESULT', undefined, `V=${velocity}, Q=${flow}`);
  }

  return ok({ velocity, flow, slope, roughness });
}

/** Manual method: the operator supplies the mean velocity directly. */
export function manualFlow(
  section: SectionProperties,
  meanVelocity: number
): Result<{ velocity: number; flow: number }, HydraulicsError> {
  if (!isPositiveFinite(section.area)) {
    return fail('INVALID_SECTION', undefined, `A=${section.area}`);
  }
  if (!Number.isFinite(meanVelocity) || meanVelocity <= 0) {
    return fail('INVALID_VELOCITY', 'velocity', `V=${meanVelocity}`);
  }
  return ok({ velocity: meanVelocity, flow: section.area * meanVelocity });
}

export interface VideoFlowResult {
  surfaceVelocity: number;
  /** Vmean = α · Vsurface. */
  meanVelocity: number;
  /** Qvideo = A · α · Vsurface. */
  flow: number;
  alpha: number;
}

/**
 * Video method.
 *
 * Vmean = α · Vsurface,  Qvideo = A · α · Vsurface
 *
 * Alpha is a site property — a default assumption or a site calibration — never
 * a universal constant, so it travels with every result and every report.
 */
export function videoFlow(
  section: SectionProperties,
  surfaceVelocity: number,
  alpha: number
): Result<VideoFlowResult, HydraulicsError> {
  if (!isPositiveFinite(section.area)) {
    return fail('INVALID_SECTION', undefined, `A=${section.area}`);
  }
  if (!Number.isFinite(surfaceVelocity) || surfaceVelocity <= 0) {
    return fail('INVALID_VELOCITY', 'surfaceVelocity', `Vs=${surfaceVelocity}`);
  }
  if (!isPositiveFinite(alpha)) return fail('INVALID_ALPHA', 'alpha', `alpha=${alpha}`);

  const meanVelocity = alpha * surfaceVelocity;
  const flow = section.area * meanVelocity;

  if (!Number.isFinite(flow)) return fail('NON_FINITE_RESULT', undefined, `Q=${flow}`);

  return ok({ surfaceVelocity, meanVelocity, flow, alpha });
}

/** Convert m³/s to litres per second, for display only. */
export function toLitresPerSecond(flowM3s: number): number {
  return flowM3s * 1000;
}

/** Convert m³/s to cubic metres per hour, for display only. */
export function toCubicMetresPerHour(flowM3s: number): number {
  return flowM3s * 3600;
}
