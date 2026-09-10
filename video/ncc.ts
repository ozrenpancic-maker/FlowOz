/**
 * Normalised cross-correlation primitives shared by the SSIV core and the
 * camera-motion estimator.
 *
 * Pure array maths — no image library, no native code — so it runs identically
 * on device and in the test suite. It is also the hot loop of the whole app, so
 * two things are done deliberately:
 *
 *  - the search image is pre-summed into integral images, which turns the
 *    window mean and variance into four lookups each instead of a second pass
 *    over the window;
 *  - the peak search is coarse-to-fine rather than exhaustive.
 *
 * Both are exact for the coarse grid they evaluate; neither changes the reported
 * correlation of the position finally chosen.
 */

export interface Grid {
  data: Float32Array | number[];
  width: number;
  height: number;
}

/** A search image with its integral images, built once per frame. */
export interface PreparedGrid extends Grid {
  /** Inclusive-exclusive prefix sums, (width + 1) × (height + 1). */
  sum: Float64Array;
  sumSquares: Float64Array;
}

export function prepareGrid(grid: Grid): PreparedGrid {
  const { width, height, data } = grid;
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const sumSquares = new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    let rowSquares = 0;
    for (let x = 0; x < width; x += 1) {
      const value = data[y * width + x] as number;
      rowSum += value;
      rowSquares += value * value;
      sum[(y + 1) * stride + (x + 1)] = (sum[y * stride + (x + 1)] as number) + rowSum;
      sumSquares[(y + 1) * stride + (x + 1)] =
        (sumSquares[y * stride + (x + 1)] as number) + rowSquares;
    }
  }

  return { ...grid, sum, sumSquares };
}

function areaSum(table: Float64Array, stride: number, x0: number, y0: number, size: number): number {
  const x1 = x0 + size;
  const y1 = y0 + size;
  return (
    (table[y1 * stride + x1] as number) -
    (table[y0 * stride + x1] as number) -
    (table[y1 * stride + x0] as number) +
    (table[y0 * stride + x0] as number)
  );
}

export function sampleAt(grid: Grid, x: number, y: number): number {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= grid.width || yi >= grid.height) return NaN;
  return grid.data[yi * grid.width + xi] as number;
}

export interface Patch {
  /** Mean-subtracted window values. Their sum is zero by construction. */
  values: Float32Array;
  mean: number;
  /** √Σ(v − mean)² — the reference term of the NCC denominator. */
  norm: number;
  size: number;
}

/**
 * Extract a square patch centred on (cx, cy). Returns null when the patch would
 * leave the frame, or when it is flat (zero variance), because a flat patch
 * carries no trackable texture.
 */
export function extractPatch(grid: Grid, cx: number, cy: number, size: number): Patch | null {
  const half = Math.floor(size / 2);
  const x0 = Math.round(cx) - half;
  const y0 = Math.round(cy) - half;
  if (x0 < 0 || y0 < 0 || x0 + size > grid.width || y0 + size > grid.height) return null;

  const values = new Float32Array(size * size);
  let sum = 0;
  for (let row = 0; row < size; row += 1) {
    const base = (y0 + row) * grid.width + x0;
    for (let col = 0; col < size; col += 1) {
      const value = grid.data[base + col] as number;
      if (!Number.isFinite(value)) return null;
      values[row * size + col] = value;
      sum += value;
    }
  }

  const mean = sum / values.length;
  let sumSquares = 0;
  for (let i = 0; i < values.length; i += 1) {
    const d = (values[i] as number) - mean;
    values[i] = d;
    sumSquares += d * d;
  }
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm < 1e-6) return null; // flat: no texture

  return { values, mean, norm, size };
}

/**
 * Zero-normalised cross-correlation of a patch against a window of `grid`.
 *
 * Because the patch is already mean-subtracted, Σ pᵢ(dᵢ − d̄) = Σ pᵢdᵢ, so the
 * window mean never has to be subtracted sample by sample.
 */
export function correlateAt(patch: Patch, grid: PreparedGrid, cx: number, cy: number): number {
  const size = patch.size;
  const half = Math.floor(size / 2);
  const x0 = Math.round(cx) - half;
  const y0 = Math.round(cy) - half;
  if (x0 < 0 || y0 < 0 || x0 + size > grid.width || y0 + size > grid.height) return NaN;

  const stride = grid.width + 1;
  const count = size * size;
  const windowSum = areaSum(grid.sum, stride, x0, y0, size);
  const windowSquares = areaSum(grid.sumSquares, stride, x0, y0, size);
  const variance = windowSquares - (windowSum * windowSum) / count;
  if (!(variance > 1e-9)) return NaN; // flat window

  let cross = 0;
  const values = patch.values;
  const data = grid.data;
  for (let row = 0; row < size; row += 1) {
    const base = (y0 + row) * grid.width + x0;
    const patchBase = row * size;
    for (let col = 0; col < size; col += 1) {
      cross += (values[patchBase + col] as number) * (data[base + col] as number);
    }
  }

  const correlation = cross / (patch.norm * Math.sqrt(variance));
  return Number.isFinite(correlation) ? correlation : NaN;
}

export interface CorrelationPeak {
  /** Integer displacement of the best match. */
  dx: number;
  dy: number;
  /** Sub-pixel refined displacement. */
  subDx: number;
  subDy: number;
  correlation: number;
  /** best / second-best, where the second peak is outside the best peak's 3×3. */
  peakRatio: number;
  /** Peak height over the RMS of the rest of the correlation surface. */
  snr: number;
  /** Sub-pixel uncertainty derived from the sharpness of the peak [px]. */
  uncertaintyPx: number;
  /** True when the best match sits on the border of the search window, i.e. the
   * true displacement probably lies outside it. */
  atSearchEdge: boolean;
}

/**
 * Search `grid` for the best match of `patch` around (cx, cy) within ±radius,
 * then refine to sub-pixel with a 1-D parabolic fit in each axis.
 *
 * The search is coarse-to-fine: a stride-2 sweep of the whole window, then a
 * dense sweep of the 5×5 neighbourhood of the coarse winner. The dense stage
 * covers every offset the parabolic refinement and the peak-ratio test read.
 */
export function findPeak(
  patch: Patch,
  grid: PreparedGrid,
  cx: number,
  cy: number,
  radius: number
): CorrelationPeak | null {
  const span = 2 * radius + 1;
  const surface = new Float32Array(span * span).fill(NaN);
  const index = (dx: number, dy: number) => (dy + radius) * span + (dx + radius);

  let evaluated = 0;
  const evaluate = (dx: number, dy: number): number => {
    if (dx < -radius || dx > radius || dy < -radius || dy > radius) return NaN;
    const slot = index(dx, dy);
    const cached = surface[slot] as number;
    if (!Number.isNaN(cached)) return cached;
    const value = correlateAt(patch, grid, cx + dx, cy + dy);
    surface[slot] = value;
    if (Number.isFinite(value)) evaluated += 1;
    return value;
  };

  let best = -Infinity;
  let bestDx = 0;
  let bestDy = 0;

  // Coarse sweep, stride 2, with the window edges always included.
  for (let dy = -radius; dy <= radius; dy += 2) {
    for (let dx = -radius; dx <= radius; dx += 2) {
      const value = evaluate(dx, dy);
      if (Number.isFinite(value) && value > best) {
        best = value;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  if (evaluated === 0 || !Number.isFinite(best)) return null;

  // Dense sweep around the coarse winner.
  for (let dy = bestDy - 2; dy <= bestDy + 2; dy += 1) {
    for (let dx = bestDx - 2; dx <= bestDx + 2; dx += 1) {
      const value = evaluate(dx, dy);
      if (Number.isFinite(value) && value > best) {
        best = value;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  // One more dense ring if the winner moved to the edge of that neighbourhood.
  for (let dy = bestDy - 1; dy <= bestDy + 1; dy += 1) {
    for (let dx = bestDx - 1; dx <= bestDx + 1; dx += 1) {
      evaluate(dx, dy);
    }
  }

  const at = (dx: number, dy: number) => {
    if (dx < -radius || dx > radius || dy < -radius || dy > radius) return NaN;
    return surface[index(dx, dy)] as number;
  };

  // Second peak and off-peak RMS over everything that was actually evaluated.
  let second = -Infinity;
  let sumSquares = 0;
  let offPeakCount = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const value = at(dx, dy);
      if (!Number.isFinite(value)) continue;
      if (Math.abs(dx - bestDx) <= 1 && Math.abs(dy - bestDy) <= 1) continue;
      if (value > second) second = value;
      sumSquares += value * value;
      offPeakCount += 1;
    }
  }

  const rms = offPeakCount > 0 ? Math.sqrt(sumSquares / offPeakCount) : NaN;
  const snr = Number.isFinite(rms) && rms > 1e-9 ? best / rms : Number.POSITIVE_INFINITY;
  // Isolation of the peak against the best *competing* peak. A runner-up at or
  // below zero is anti-correlated, which is the absence of a competitor rather
  // than a close one, so it must not be turned into a small denominator by
  // taking its magnitude.
  const peakRatio =
    Number.isFinite(second) && second > 1e-9 ? best / second : Number.POSITIVE_INFINITY;

  // Parabolic sub-pixel refinement, one axis at a time.
  const refine = (minus: number, centre: number, plus: number) => {
    if (!Number.isFinite(minus) || !Number.isFinite(plus)) return { shift: 0, curvature: 0 };
    const denominator = minus - 2 * centre + plus;
    if (Math.abs(denominator) < 1e-9) return { shift: 0, curvature: 0 };
    const shift = (0.5 * (minus - plus)) / denominator;
    // A refinement beyond one cell means the parabola does not describe the
    // peak; fall back to the integer position.
    return { shift: Math.abs(shift) <= 1 ? shift : 0, curvature: Math.abs(denominator) };
  };

  const xRefine = refine(at(bestDx - 1, bestDy), best, at(bestDx + 1, bestDy));
  const yRefine = refine(at(bestDx, bestDy - 1), best, at(bestDx, bestDy + 1));

  const curvature = Math.max(1e-9, (xRefine.curvature + yRefine.curvature) / 2);
  // A sharper peak and a higher correlation mean a smaller sub-pixel bound.
  // This is a diagnostic bound, not a validated measurement uncertainty.
  const uncertaintyPx = Math.sqrt(Math.max(0, 1 - Math.min(1, best)) / curvature);

  return {
    dx: bestDx,
    dy: bestDy,
    subDx: bestDx + xRefine.shift,
    subDy: bestDy + yRefine.shift,
    correlation: best,
    peakRatio,
    snr,
    uncertaintyPx: Number.isFinite(uncertaintyPx) ? uncertaintyPx : Number.POSITIVE_INFINITY,
    atSearchEdge: Math.abs(bestDx) === radius || Math.abs(bestDy) === radius,
  };
}
