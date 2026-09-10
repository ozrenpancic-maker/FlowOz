import { err, ok, type FailureBase, type Result } from './result';
import { median, medianAbsoluteDeviation, solveLinearSystem } from './linalg';

/**
 * Rotated-ellipse fit for the camera-assisted level of a circular pipe.
 *
 * The operator marks 8–12 points on the pipe rim and two points on the water
 * line. A circular rim images as an ellipse; fitting it gives an affine map
 * from the image back to the pipe face.
 *
 * Deliberate limitation, carried in the result and shown in the UI: this is an
 * affine model, not a calibrated perspective one. A small algebraic residual
 * only proves the conic passes through the clicked points — it is not evidence
 * of metrological accuracy, and this module never reports it as such.
 */

export interface Point2D {
  x: number;
  y: number;
}

export type EllipseErrorCode =
  | 'TOO_FEW_POINTS'
  | 'DEGENERATE_CONFIGURATION'
  | 'NOT_AN_ELLIPSE'
  | 'FIT_DID_NOT_CONVERGE'
  | 'WATERLINE_OUTSIDE_RIM';

export interface EllipseError extends FailureBase<EllipseErrorCode> {}

function fail(code: EllipseErrorCode, detail?: string) {
  return err<EllipseError>({ code, messageKey: `ellipse.error.${code}`, detail });
}

export const MIN_RIM_POINTS = 8;
export const MAX_RIM_POINTS = 12;

export interface EllipseFit {
  /** Conic coefficients for a·x² + b·xy + c·y² + d·x + e·y + f = 0. */
  conic: { a: number; b: number; c: number; d: number; e: number; f: number };
  centre: Point2D;
  /** Semi-major and semi-minor axes, in the same units as the input points. */
  semiMajor: number;
  semiMinor: number;
  /** Rotation of the major axis from +x, in radians. */
  rotation: number;
  /** RMS geometric residual of the inlier points [px]. */
  residual: number;
  inlierCount: number;
  rejectedCount: number;
  /** semiMinor / semiMajor. A very small value means an extreme viewing angle. */
  axisRatio: number;
}

interface Normalisation {
  cx: number;
  cy: number;
  scale: number;
}

function normalise(points: readonly Point2D[]): Normalisation | null {
  const n = points.length;
  const cx = points.reduce((sum, p) => sum + p.x, 0) / n;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / n;
  const meanDistance =
    points.reduce((sum, p) => sum + Math.hypot(p.x - cx, p.y - cy), 0) / n;
  if (!Number.isFinite(meanDistance) || meanDistance < 1e-9) return null;
  return { cx, cy, scale: Math.SQRT2 / meanDistance };
}

/**
 * Algebraic conic fit with f pinned to −1, solved through the normal
 * equations. Points are centred and scaled first, which keeps the origin inside
 * the rim and makes the f ≠ 0 assumption safe.
 */
function fitConicOnce(points: readonly Point2D[], norm: Normalisation) {
  const design: number[][] = [];
  const rhs: number[] = [];

  for (const point of points) {
    const x = (point.x - norm.cx) * norm.scale;
    const y = (point.y - norm.cy) * norm.scale;
    design.push([x * x, x * y, y * y, x, y]);
    rhs.push(1);
  }

  // Normal equations: (Dᵀ D) θ = Dᵀ 1
  const ata: number[][] = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
  const atb: number[] = new Array<number>(5).fill(0);
  for (let row = 0; row < design.length; row += 1) {
    const d = design[row] as number[];
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        (ata[i] as number[])[j] = ((ata[i] as number[])[j] as number) + (d[i] as number) * (d[j] as number);
      }
      atb[i] = (atb[i] as number) + (d[i] as number) * (rhs[row] as number);
    }
  }

  const solution = solveLinearSystem(ata, atb);
  if (!solution) return null;

  const [a, b, c, d, e] = solution as [number, number, number, number, number];
  return { a, b, c, d, e, f: -1 };
}

/** Geometric residual of a point against a conic, approximated by the
 * algebraic value scaled by the gradient magnitude (Sampson distance). */
function sampsonDistance(
  conic: { a: number; b: number; c: number; d: number; e: number; f: number },
  x: number,
  y: number
): number {
  const value =
    conic.a * x * x + conic.b * x * y + conic.c * y * y + conic.d * x + conic.e * y + conic.f;
  const gx = 2 * conic.a * x + conic.b * y + conic.d;
  const gy = 2 * conic.c * y + conic.b * x + conic.e;
  const gradient = Math.hypot(gx, gy);
  if (gradient < 1e-12) return Number.POSITIVE_INFINITY;
  return Math.abs(value) / gradient;
}

/** Median residual below which the conic is taken to pass through the marks. */
const GOOD_FIT_RESIDUAL = 0.02;

interface SubsetFit {
  conic: { a: number; b: number; c: number; d: number; e: number; f: number };
  norm: Normalisation;
  /** Median Sampson residual in normalised coordinates. */
  medianResidual: number;
}

function fitSubset(points: readonly Point2D[]): SubsetFit | null {
  const norm = normalise(points);
  if (!norm) return null;
  const conic = fitConicOnce(points, norm);
  if (!conic) return null;
  const residuals = points.map((point) =>
    sampsonDistance(conic, (point.x - norm.cx) * norm.scale, (point.y - norm.cy) * norm.scale)
  );
  const medianResidual = median(residuals);
  if (!Number.isFinite(medianResidual)) return null;
  return { conic, norm, medianResidual };
}

/**
 * Fit a rotated ellipse robustly: fit, and if the conic does not pass through
 * the marked points, drop the single worst mark and refit. Collinear or
 * otherwise degenerate point sets are rejected outright rather than "fitted".
 */
export function fitEllipse(points: readonly Point2D[]): Result<EllipseFit, EllipseError> {
  if (points.length < MIN_RIM_POINTS) {
    return fail('TOO_FEW_POINTS', `${points.length} < ${MIN_RIM_POINTS}`);
  }
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return fail('DEGENERATE_CONFIGURATION', 'non-finite point');
  }

  if (isNearlyCollinear(points)) return fail('DEGENERATE_CONFIGURATION', 'points are collinear');

  const initial = fitSubset(points);
  if (!initial) return fail('FIT_DID_NOT_CONVERGE', 'singular normal equations');

  let working = [...points];
  let current = initial;
  let rejected = 0;

  /*
   * Robust pass by leave-one-out.
   *
   * A single badly placed tap dominates an algebraic fit, and residuals
   * measured against that spoiled fit point at the *good* points — which is why
   * a plain residual threshold would throw away the wrong ones. Instead, when
   * the fit does not already pass through the marks, each point is excluded in
   * turn and the exclusion that most improves the median residual wins. It is
   * O(n) fits on at most 12 points, so the cost is irrelevant on device.
   */
  const maxRejections = Math.max(0, points.length - MIN_RIM_POINTS);
  for (let iteration = 0; iteration < maxRejections && iteration < 3; iteration += 1) {
    if (current.medianResidual <= GOOD_FIT_RESIDUAL) break;

    let bestIndex = -1;
    let bestFit: SubsetFit | null = null;
    for (let index = 0; index < working.length; index += 1) {
      const subset = working.filter((_, other) => other !== index);
      const candidate = fitSubset(subset);
      if (!candidate) continue;
      if (!bestFit || candidate.medianResidual < bestFit.medianResidual) {
        bestFit = candidate;
        bestIndex = index;
      }
    }

    // Only drop a point when leaving it out is a decisive improvement.
    if (!bestFit || bestIndex < 0 || bestFit.medianResidual > current.medianResidual / 2) break;

    working = working.filter((_, other) => other !== bestIndex);
    current = bestFit;
    rejected += 1;
  }

  const conic = current.conic;
  const norm = current.norm;

  const { a, b, c, d, e, f } = conic;
  const discriminant = b * b - 4 * a * c;
  if (!(discriminant < 0)) {
    // Parabola or hyperbola — the marked points do not describe a pipe rim.
    return fail('NOT_AN_ELLIPSE', `b²−4ac=${discriminant}`);
  }

  // Centre of the conic in normalised coordinates.
  const centreX = (2 * c * d - b * e) / discriminant;
  const centreY = (2 * a * e - b * d) / discriminant;

  const fCentre =
    a * centreX * centreX + b * centreX * centreY + c * centreY * centreY + d * centreX + e * centreY + f;
  const common = Math.sqrt((a - c) * (a - c) + b * b);
  if (a + c + common === 0 || a + c - common === 0) {
    return fail('FIT_DID_NOT_CONVERGE', 'degenerate axes');
  }

  /*
   * Semi-axes and orientation from the eigen-decomposition of [[a, b/2], [b/2, c]].
   * The semi-axis along an eigenvector is √(−f_centre / λ), so the LARGER axis
   * belongs to the SMALLER eigenvalue — getting that backwards would report the
   * minor axis direction as the rotation and skew every depth read off the rim.
   */
  const lambdaMinus = (a + c - common) / 2;
  const lambdaPlus = (a + c + common) / 2;
  const axisFor = (lambda: number) => Math.sqrt(Math.abs(-fCentre / lambda));
  const majorLambda = Math.abs(lambdaMinus) <= Math.abs(lambdaPlus) ? lambdaMinus : lambdaPlus;
  const minorLambda = majorLambda === lambdaMinus ? lambdaPlus : lambdaMinus;
  const semiMajorNorm = axisFor(majorLambda);
  const semiMinorNorm = axisFor(minorLambda);

  if (!Number.isFinite(semiMajorNorm) || !Number.isFinite(semiMinorNorm) || semiMinorNorm <= 0) {
    return fail('FIT_DID_NOT_CONVERGE', `axes=${semiMajorNorm}/${semiMinorNorm}`);
  }

  // Eigenvector of the major axis: (a − λ)x + (b/2)y = 0.
  const rotation =
    Math.abs(b) < 1e-12
      ? Math.abs(a) <= Math.abs(c)
        ? 0
        : Math.PI / 2
      : Math.atan2(majorLambda - a, b / 2);

  const residuals = working.map((point) =>
    sampsonDistance(conic, (point.x - norm.cx) * norm.scale, (point.y - norm.cy) * norm.scale)
  );
  const rms =
    Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length) / norm.scale;

  const semiMajor = semiMajorNorm / norm.scale;
  const semiMinor = semiMinorNorm / norm.scale;

  return ok({
    conic,
    centre: { x: centreX / norm.scale + norm.cx, y: centreY / norm.scale + norm.cy },
    semiMajor,
    semiMinor,
    rotation,
    residual: rms,
    inlierCount: working.length,
    rejectedCount: rejected,
    axisRatio: semiMinor / semiMajor,
  });
}

/** True when the points lie so close to a straight line that no ellipse is
 * determined by them. */
export function isNearlyCollinear(points: readonly Point2D[], tolerance = 1e-3): boolean {
  const n = points.length;
  if (n < 3) return true;
  const cx = points.reduce((sum, p) => sum + p.x, 0) / n;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / n;

  // Second-moment matrix; the ratio of its eigenvalues measures elongation.
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  sxx /= n;
  sxy /= n;
  syy /= n;

  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  if (trace <= 0) return true;
  const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const lambdaMax = trace / 2 + disc;
  const lambdaMin = trace / 2 - disc;
  if (lambdaMax <= 0) return true;
  return lambdaMin / lambdaMax < tolerance;
}

export type LevelConfidence = 'INDICATIVE' | 'WEAK';

export interface CameraLevelEstimate {
  /** Water depth h [m]. */
  depth: number;
  /** Fill ratio h/D as read off the fitted rim. */
  fillRatio: number;
  fit: EllipseFit;
  /**
   * Never 'HIGH'. The affine model cannot prove perspective accuracy, so the
   * best this method reports is INDICATIVE, and the UI states the limitation.
   */
  confidence: LevelConfidence;
  limitationKey: string;
}

/**
 * Estimate the water depth from a fitted rim and two points on the water line.
 *
 * The rim ellipse is inverted to a unit circle (an affine approximation of the
 * true perspective map); the water line becomes a chord of that circle and the
 * fill ratio is read directly. The gravity vector recorded with the photo fixes
 * which side of the chord is the invert.
 */
export function estimateDepthFromRim(
  fit: EllipseFit,
  waterline: readonly [Point2D, Point2D],
  diameter: number,
  gravity?: { x: number; y: number }
): Result<CameraLevelEstimate, EllipseError> {
  if (!Number.isFinite(diameter) || diameter <= 0) {
    return fail('DEGENERATE_CONFIGURATION', `D=${diameter}`);
  }

  const cos = Math.cos(-fit.rotation);
  const sin = Math.sin(-fit.rotation);

  // Image point → rim-aligned unit circle.
  const toUnitCircle = (point: Point2D) => {
    const dx = point.x - fit.centre.x;
    const dy = point.y - fit.centre.y;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return { x: rx / fit.semiMajor, y: ry / fit.semiMinor };
  };

  const p1 = toUnitCircle(waterline[0]);
  const p2 = toUnitCircle(waterline[1]);
  if (![p1.x, p1.y, p2.x, p2.y].every(Number.isFinite)) {
    return fail('DEGENERATE_CONFIGURATION', 'waterline maps to a non-finite point');
  }

  // "Down" in the unit-circle frame, from the recorded gravity vector when it
  // is available, otherwise image-down (+y).
  const gx = gravity && Number.isFinite(gravity.x) ? gravity.x : 0;
  const gy = gravity && Number.isFinite(gravity.y) ? gravity.y : 1;
  const gLength = Math.hypot(gx, gy) || 1;
  const downX = (gx / gLength) * cos - (gy / gLength) * sin;
  const downY = (gx / gLength) * sin + (gy / gLength) * cos;
  const downUnit = { x: downX / fit.semiMajor, y: downY / fit.semiMinor };
  const downNorm = Math.hypot(downUnit.x, downUnit.y) || 1;
  const dx = downUnit.x / downNorm;
  const dy = downUnit.y / downNorm;

  // Signed position of the water line along "down", averaged over both points.
  const projection = ((p1.x * dx + p1.y * dy) + (p2.x * dx + p2.y * dy)) / 2;
  if (!Number.isFinite(projection)) {
    return fail('DEGENERATE_CONFIGURATION', 'waterline projection is not finite');
  }
  if (projection < -1 || projection > 1) {
    return fail('WATERLINE_OUTSIDE_RIM', `projection=${projection.toFixed(3)}`);
  }

  // projection = +1 at the invert, −1 at the crown.
  const fillRatio = (1 - projection) / 2;
  if (!(fillRatio > 0) || !(fillRatio < 1)) {
    return fail('WATERLINE_OUTSIDE_RIM', `h/D=${fillRatio}`);
  }

  // An extremely oblique view or a poorly determined conic can produce a
  // plausible-looking number from bad evidence; say so instead of hiding it.
  const confidence: LevelConfidence =
    fit.axisRatio < 0.15 || fit.inlierCount < MIN_RIM_POINTS ? 'WEAK' : 'INDICATIVE';

  return ok({
    depth: fillRatio * diameter,
    fillRatio,
    fit,
    confidence,
    limitationKey: 'level.camera.affineModelLimitation',
  });
}
