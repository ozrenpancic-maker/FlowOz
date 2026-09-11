import { median } from '../domain/linalg';
import type { LateralVelocityColumn } from '../domain/lateral-profile';
import type { EnsembleVector, SsivAnalysis, SsivVector } from './types';

/**
 * The measured lateral profile: one velocity per ROI column that actually
 * produced an accepted measurement, read off whichever stage of the analysis
 * the reported surface velocity itself came from — the ensemble nodes when
 * `velocitySource` is 'ensemble', the per-pair vectors otherwise, so the
 * profile is always built from the same evidence the headline figure was.
 *
 * A column with no accepted entry is simply absent, never a manufactured
 * zero — `integrateVelocityAreaDischarge` is what decides whether the gaps
 * are small enough to still integrate.
 */
export interface LateralProfileResult {
  columns: LateralVelocityColumn[];
  columnsTotal: number;
}

export function lateralVelocityProfile(analysis: SsivAnalysis): LateralProfileResult {
  const columns = new Map<number, number[]>();

  const collect = (column: number, velocityMs: number | undefined) => {
    if (velocityMs === undefined || !Number.isFinite(velocityMs)) return;
    const list = columns.get(column);
    if (list) list.push(velocityMs);
    else columns.set(column, [velocityMs]);
  };

  if (analysis.velocitySource === 'ensemble') {
    for (const node of analysis.ensemble as EnsembleVector[]) {
      if (node.accepted) collect(node.gridColumn, node.velocityMs);
    }
  } else {
    for (const vector of analysis.vectors as SsivVector[]) {
      if (vector.accepted) collect(vector.gridColumn, vector.velocityMs);
    }
  }

  // The grid's own column count, not the highest column that happened to
  // survive — inferring it from what is present would shrink the coverage
  // denominator right when a whole edge column is missing, hiding the gap it
  // is meant to catch.
  const totalColumns = analysis.thresholds.gridColumns;
  const result: LateralVelocityColumn[] = [];
  for (const [column, velocities] of columns) {
    result.push({
      column,
      u: (column + 0.5) / totalColumns,
      surfaceVelocityMs: median(velocities),
      sampleCount: velocities.length,
    });
  }
  return { columns: result.sort((a, b) => a.column - b.column), columnsTotal: totalColumns };
}
