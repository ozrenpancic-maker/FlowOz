/**
 * Plausibility gate.
 *
 * Two strictly separate outcomes, per the specification:
 *  - `blocking`  — physically impossible. The workflow stops; the operator must
 *                  correct the value.
 *  - `advisory`  — unusual but possible. The operator confirms and the value is
 *                  kept exactly as entered. FLOWVISION never silently clamps,
 *                  rounds or substitutes an operator's number.
 */

export type PlausibilitySeverity = 'blocking' | 'advisory';

export interface PlausibilityFinding {
  severity: PlausibilitySeverity;
  code: string;
  messageKey: string;
  field: string;
  value: number;
  detail?: string;
}

export interface PlausibilityReport {
  findings: PlausibilityFinding[];
  /** True when at least one physically impossible value is present. */
  blocked: boolean;
  /** Advisory findings the operator has to acknowledge before calculating. */
  advisories: PlausibilityFinding[];
}

interface Range {
  /** Below this the value is physically impossible. */
  hardMin?: number;
  /** Above this the value is physically impossible. */
  hardMax?: number;
  /** Outside [softMin, softMax] the value is unusual but possible. */
  softMin?: number;
  softMax?: number;
}

/** Field ranges of the reference implementation, all in SI units. */
export const PLAUSIBILITY_RANGES: Record<string, Range> = {
  // Pipe diameters from a 25 mm sampling line to a 5 m culvert.
  diameter: { hardMin: 0.01, hardMax: 20, softMin: 0.05, softMax: 5 },
  width: { hardMin: 0.01, hardMax: 100, softMin: 0.05, softMax: 20 },
  bottomWidth: { hardMin: 0, hardMax: 100, softMax: 20 },
  depth: { hardMin: 0.0005, hardMax: 20, softMin: 0.005, softMax: 5 },
  // Manning n: glass ≈ 0.009, heavily vegetated channels ≈ 0.15.
  roughness: { hardMin: 0.005, hardMax: 0.5, softMin: 0.009, softMax: 0.15 },
  // Hydraulic gradient in ‰.
  slopePermille: { hardMin: 0.001, hardMax: 1000, softMin: 0.05, softMax: 200 },
  velocity: { hardMin: 0.0001, hardMax: 20, softMin: 0.02, softMax: 8 },
  surfaceVelocity: { hardMin: 0.0001, hardMax: 20, softMin: 0.02, softMax: 8 },
  alpha: { hardMin: 0.1, hardMax: 2, softMin: 0.7, softMax: 1.0 },
  roiWidthM: { hardMin: 0.005, hardMax: 500, softMin: 0.05, softMax: 50 },
  roiLengthM: { hardMin: 0.005, hardMax: 500, softMin: 0.05, softMax: 50 },
  flowM3s: { hardMin: 0, hardMax: 10000, softMax: 1000 },
};

export function checkValue(field: string, value: number): PlausibilityFinding[] {
  const range = PLAUSIBILITY_RANGES[field];
  const findings: PlausibilityFinding[] = [];

  if (!Number.isFinite(value)) {
    findings.push({
      severity: 'blocking',
      code: 'NOT_FINITE',
      messageKey: 'plausibility.notFinite',
      field,
      value,
    });
    return findings;
  }
  if (!range) return findings;

  if (range.hardMin !== undefined && value < range.hardMin) {
    findings.push({
      severity: 'blocking',
      code: 'BELOW_PHYSICAL_MINIMUM',
      messageKey: 'plausibility.belowPhysicalMinimum',
      field,
      value,
      detail: `min ${range.hardMin}`,
    });
  } else if (range.hardMax !== undefined && value > range.hardMax) {
    findings.push({
      severity: 'blocking',
      code: 'ABOVE_PHYSICAL_MAXIMUM',
      messageKey: 'plausibility.abovePhysicalMaximum',
      field,
      value,
      detail: `max ${range.hardMax}`,
    });
  } else if (range.softMin !== undefined && value < range.softMin) {
    findings.push({
      severity: 'advisory',
      code: 'UNUSUALLY_LOW',
      messageKey: 'plausibility.unusuallyLow',
      field,
      value,
      detail: `typical ≥ ${range.softMin}`,
    });
  } else if (range.softMax !== undefined && value > range.softMax) {
    findings.push({
      severity: 'advisory',
      code: 'UNUSUALLY_HIGH',
      messageKey: 'plausibility.unusuallyHigh',
      field,
      value,
      detail: `typical ≤ ${range.softMax}`,
    });
  }

  return findings;
}

export function buildReport(values: Record<string, number | null | undefined>): PlausibilityReport {
  const findings: PlausibilityFinding[] = [];
  for (const [field, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    findings.push(...checkValue(field, value));
  }
  return {
    findings,
    blocked: findings.some((f) => f.severity === 'blocking'),
    advisories: findings.filter((f) => f.severity === 'advisory'),
  };
}
