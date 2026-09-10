/**
 * Small dense linear algebra used by the conic fit and the homography solver.
 * Pure functions, no dependencies — the maths stays testable away from the UI.
 */

export type Matrix = number[][];

/**
 * Solve A·x = b by Gauss–Jordan elimination with partial pivoting.
 * Returns null for a singular or near-singular system rather than producing a
 * numerically meaningless answer.
 */
export function solveLinearSystem(a: Matrix, b: number[], tolerance = 1e-12): number[] | null {
  const n = b.length;
  if (a.length !== n) return null;

  // Work on copies; callers keep their design matrices.
  const m: Matrix = a.map((row, i) => {
    if (row.length !== n) return [];
    return [...row, b[i] as number];
  });
  if (m.some((row) => row.length !== n + 1)) return null;

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let pivotValue = Math.abs((m[col] as number[])[col] as number);
    for (let row = col + 1; row < n; row += 1) {
      const candidate = Math.abs((m[row] as number[])[col] as number);
      if (candidate > pivotValue) {
        pivotValue = candidate;
        pivotRow = row;
      }
    }
    if (!Number.isFinite(pivotValue) || pivotValue < tolerance) return null;

    if (pivotRow !== col) {
      const tmp = m[col] as number[];
      m[col] = m[pivotRow] as number[];
      m[pivotRow] = tmp;
    }

    const pivot = m[col] as number[];
    const pivotElement = pivot[col] as number;
    for (let k = col; k <= n; k += 1) {
      pivot[k] = (pivot[k] as number) / pivotElement;
    }

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const target = m[row] as number[];
      const factor = target[col] as number;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) {
        target[k] = (target[k] as number) - factor * (pivot[k] as number);
      }
    }
  }

  const solution = m.map((row) => row[n] as number);
  return solution.every((value) => Number.isFinite(value)) ? solution : null;
}

/** Determinant of a 3×3 matrix given in row-major order. */
export function determinant3(m: readonly number[]): number {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  return (
    (a as number) * ((e as number) * (i as number) - (f as number) * (h as number)) -
    (b as number) * ((d as number) * (i as number) - (f as number) * (g as number)) +
    (c as number) * ((d as number) * (h as number) - (e as number) * (g as number))
  );
}

/** Inverse of a 3×3 matrix in row-major order, or null when singular. */
export function invert3(m: readonly number[]): number[] | null {
  const det = determinant3(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  const inv = [
    (e as number) * (i as number) - (f as number) * (h as number),
    (c as number) * (h as number) - (b as number) * (i as number),
    (b as number) * (f as number) - (c as number) * (e as number),
    (f as number) * (g as number) - (d as number) * (i as number),
    (a as number) * (i as number) - (c as number) * (g as number),
    (c as number) * (d as number) - (a as number) * (f as number),
    (d as number) * (h as number) - (e as number) * (g as number),
    (b as number) * (g as number) - (a as number) * (h as number),
    (a as number) * (e as number) - (b as number) * (d as number),
  ].map((value) => value / det);
  return inv.every((value) => Number.isFinite(value)) ? inv : null;
}

/** Median of a sample. Returns NaN for an empty sample — callers must check. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Median absolute deviation, scaled to be a consistent estimator of sigma for
 * normally distributed data. This is the outlier gate used by the SSIV core.
 */
export function medianAbsoluteDeviation(values: readonly number[], centre?: number): number {
  if (values.length === 0) return NaN;
  const mid = centre ?? median(values);
  const deviations = values.map((value) => Math.abs(value - mid));
  return 1.4826 * median(deviations);
}
