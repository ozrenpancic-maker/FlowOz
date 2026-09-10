/**
 * Unit handling. Operators enter dimensions in mm / cm / m; every internal
 * computation in FLOWVISION is done in SI base units (metres, seconds).
 */

export type LengthUnit = 'mm' | 'cm' | 'm';

export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'cm', 'm'] as const;

const TO_METRES: Record<LengthUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
};

export function isLengthUnit(value: unknown): value is LengthUnit {
  return typeof value === 'string' && value in TO_METRES;
}

/** Convert a length expressed in `unit` into metres. */
export function toMetres(value: number, unit: LengthUnit): number {
  return value * TO_METRES[unit];
}

/** Convert a length in metres into `unit`. */
export function fromMetres(metres: number, unit: LengthUnit): number {
  return metres / TO_METRES[unit];
}

/**
 * Operators enter the hydraulic gradient in per-mille (‰). The dimensionless
 * slope S used by Manning is `permille / 1000`.
 */
export function permilleToSlope(permille: number): number {
  return permille / 1000;
}

export function slopeToPermille(slope: number): number {
  return slope * 1000;
}

/** How the operator prefers to enter the hydraulic gradient. */
export type SlopeUnit = 'permille' | 'degrees';

export const SLOPE_UNITS: readonly SlopeUnit[] = ['permille', 'degrees'] as const;

export function isSlopeUnit(value: unknown): value is SlopeUnit {
  return value === 'permille' || value === 'degrees';
}

/**
 * Bed angle to gradient. The gradient is the tangent of the angle — rise over
 * run — which is what Manning's S means; for the shallow angles of a channel
 * the sine would be within rounding of it, but the tangent is the definition.
 */
export function degreesToPermille(degrees: number): number {
  return Math.tan((degrees * Math.PI) / 180) * 1000;
}

export function permilleToDegrees(permille: number): number {
  return (Math.atan(permille / 1000) * 180) / Math.PI;
}

/** A finite, strictly positive number — the precondition of most hydraulics. */
export function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Parse operator input. Accepts both decimal separators because the app ships
 * EN and HR locales. Returns null for anything that is not a finite number,
 * never NaN, never a silent 0.
 */
export function parseNumericInput(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '' || trimmed === '-' || trimmed === '.') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Fixed-decimal formatting that never renders `NaN` or `Infinity`. */
export function formatNumber(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(decimals);
}
