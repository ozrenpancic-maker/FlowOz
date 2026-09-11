import { determinant3, invert3, solveLinearSystem } from '../domain/linalg';
import { err, ok, type Result } from '../domain/result';
import type { KnownRoiDimensions, NormalizedPoint, WaterRoi } from '../domain/types';
import { toPixels, validateRoi, type RoiProblem } from './roi';
import type { CalibrationStatus } from './types';

/**
 * Plane-to-plane homography between the image and the water surface.
 *
 * The only supported metric scale is Known ROI Dimensions: the operator states
 * the physical width across the flow and the physical length along it. Those
 * four correspondences determine the map. There is deliberately no experimental
 * pixel-scale fallback — without a stated physical size there is no metric
 * velocity, and the app says so rather than inventing one.
 */

export interface Homography {
  /** Image pixels → metres on the water plane, row-major 3×3. */
  forward: number[];
  /** Metres → image pixels, row-major 3×3. */
  inverse: number[];
  determinant: number;
  /**
   * Largest image→world→image round-trip error over the four corners [px].
   * This is a solver self-consistency check, not a metrological one: the same
   * four correspondences both define the map and are used to check it, so a
   * small value only proves the linear solve was well-conditioned. It says
   * nothing about how well those four points were actually placed on the true
   * water edges, camera lens distortion, or perspective — none of which this
   * homography model accounts for.
   */
  numericalClosureErrorPx: number;
  status: CalibrationStatus;
  problems: RoiProblem[];
}

export type HomographyErrorCode =
  | 'ROI_INVALID'
  | 'UNSOLVABLE'
  | 'SINGULAR'
  | 'CLOSURE_CHECK_FAILED';

export interface HomographyError {
  code: HomographyErrorCode;
  messageKey: string;
  detail?: string;
  problems: RoiProblem[];
}

/** Round-trip closure tolerance at working resolution [px]. */
const MAX_CLOSURE_ERROR_PX = 0.5;
/** Above this the map is usable but flagged POOR. */
const POOR_CLOSURE_ERROR_PX = 0.05;
const MIN_ABS_DETERMINANT = 1e-12;

export function applyHomography(h: readonly number[], x: number, y: number) {
  const u = (h[0] as number) * x + (h[1] as number) * y + (h[2] as number);
  const v = (h[3] as number) * x + (h[4] as number) * y + (h[5] as number);
  const w = (h[6] as number) * x + (h[7] as number) * y + (h[8] as number);
  if (!Number.isFinite(w) || Math.abs(w) < 1e-14) return null;
  const px = u / w;
  const py = v / w;
  return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null;
}

/**
 * Solve the 8-parameter homography from four point correspondences (DLT with
 * h33 pinned to 1).
 */
export function solveHomography(
  source: readonly { x: number; y: number }[],
  target: readonly { x: number; y: number }[]
): number[] | null {
  if (source.length !== 4 || target.length !== 4) return null;

  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const s = source[i] as { x: number; y: number };
    const t = target[i] as { x: number; y: number };
    if (![s.x, s.y, t.x, t.y].every(Number.isFinite)) return null;
    a.push([s.x, s.y, 1, 0, 0, 0, -s.x * t.x, -s.y * t.x]);
    b.push(t.x);
    a.push([0, 0, 0, s.x, s.y, 1, -s.x * t.y, -s.y * t.y]);
    b.push(t.y);
  }

  const solution = solveLinearSystem(a, b);
  if (!solution) return null;
  return [...solution, 1];
}

/**
 * Build and validate the calibration for a ROI plus its known physical size.
 *
 * The physical frame places the ROI's top-left corner at the origin, the width
 * along +x (across the flow) and the length along +y (downstream).
 */
export function buildCalibration(
  roi: WaterRoi,
  dimensions: KnownRoiDimensions,
  frameWidth: number,
  frameHeight: number
): Result<Homography, HomographyError> {
  const problems = validateRoi(roi, dimensions);
  if (problems.length > 0) {
    return err({
      code: 'ROI_INVALID',
      messageKey: 'homography.error.ROI_INVALID',
      detail: problems.map((problem) => problem.code).join(', '),
      problems,
    });
  }
  if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) || frameWidth <= 0 || frameHeight <= 0) {
    return err({
      code: 'UNSOLVABLE',
      messageKey: 'homography.error.UNSOLVABLE',
      detail: `frame ${frameWidth}×${frameHeight}`,
      problems,
    });
  }

  const imagePoints = [roi.topLeft, roi.topRight, roi.bottomRight, roi.bottomLeft].map((point) =>
    toPixels(point, frameWidth, frameHeight)
  );
  const { widthM, lengthM } = dimensions;
  const worldPoints = [
    { x: 0, y: 0 },
    { x: widthM, y: 0 },
    { x: widthM, y: lengthM },
    { x: 0, y: lengthM },
  ];

  const forward = solveHomography(imagePoints, worldPoints);
  if (!forward) {
    return err({
      code: 'UNSOLVABLE',
      messageKey: 'homography.error.UNSOLVABLE',
      detail: 'forward map has no solution',
      problems,
    });
  }

  const determinant = determinant3(forward);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < MIN_ABS_DETERMINANT) {
    return err({
      code: 'SINGULAR',
      messageKey: 'homography.error.SINGULAR',
      detail: `det=${determinant}`,
      problems,
    });
  }

  const inverse = invert3(forward);
  if (!inverse) {
    return err({
      code: 'SINGULAR',
      messageKey: 'homography.error.SINGULAR',
      detail: 'forward map is not invertible',
      problems,
    });
  }

  // Numerical closure: image → world → image must return the same corners.
  // This only catches a badly conditioned solve (e.g. near-collinear points);
  // it cannot detect a homography built from four confidently, precisely
  // wrong clicks, which would close perfectly and still be wrong.
  let numericalClosureErrorPx = 0;
  for (const point of imagePoints) {
    const world = applyHomography(forward, point.x, point.y);
    if (!world) {
      return err({
        code: 'CLOSURE_CHECK_FAILED',
        messageKey: 'homography.error.CLOSURE_CHECK_FAILED',
        detail: 'forward map produced a point at infinity',
        problems,
      });
    }
    const back = applyHomography(inverse, world.x, world.y);
    if (!back) {
      return err({
        code: 'CLOSURE_CHECK_FAILED',
        messageKey: 'homography.error.CLOSURE_CHECK_FAILED',
        detail: 'inverse map produced a point at infinity',
        problems,
      });
    }
    numericalClosureErrorPx = Math.max(
      numericalClosureErrorPx,
      Math.hypot(back.x - point.x, back.y - point.y)
    );
  }

  if (!Number.isFinite(numericalClosureErrorPx) || numericalClosureErrorPx > MAX_CLOSURE_ERROR_PX) {
    return err({
      code: 'CLOSURE_CHECK_FAILED',
      messageKey: 'homography.error.CLOSURE_CHECK_FAILED',
      detail: `${numericalClosureErrorPx.toFixed(4)} px > ${MAX_CLOSURE_ERROR_PX} px`,
      problems,
    });
  }

  // VALID/POOR describes the numerical conditioning of this solve, not the
  // real-world accuracy of the four points the operator clicked — see
  // numericalClosureErrorPx's own doc comment.
  const status: CalibrationStatus = numericalClosureErrorPx > POOR_CLOSURE_ERROR_PX ? 'POOR' : 'VALID';

  return ok({ forward, inverse, determinant, numericalClosureErrorPx, status, problems });
}

/**
 * Metric length of a displacement, mapped through the homography. Both ends of
 * the displacement are projected separately — a homography is not linear, so a
 * single scale factor would be wrong.
 */
/**
 * Rebuild the ROI's four corners so they enclose the exact same real-world
 * rectangle (`dimensions` is unchanged), shifted by (deltaAcrossM,
 * deltaAlongM) along the calibration plane's own axes — across the flow and
 * downstream respectively.
 *
 * This is the operation the manual point-dragging in RoiEditor cannot do by
 * itself: perspective means the same physical size covers a different pixel
 * footprint depending on where in the frame it sits, so eyeballing a new
 * position for an already-measured rectangle silently changes its real
 * width/length unless the move is computed through the homography, not
 * clicked freehand.
 *
 * Requires a currently valid calibration — without one there is no
 * established metres-per-pixel relationship to move within, so the caller
 * gets null rather than a guess. The result can still land outside the
 * visible frame (validateRoi's own POINT_OUTSIDE_FRAME reports that, same as
 * any other out-of-frame point) — the camera genuinely does not see that far,
 * which is not something to silently paper over here.
 */
export function translateRoi(
  roi: WaterRoi,
  dimensions: KnownRoiDimensions,
  frameWidth: number,
  frameHeight: number,
  deltaAcrossM: number,
  deltaAlongM: number
): WaterRoi | null {
  const calibration = buildCalibration(roi, dimensions, frameWidth, frameHeight);
  if (!calibration.ok) return null;
  const { widthM, lengthM } = dimensions;
  const inverse = calibration.value.inverse;

  const project = (worldX: number, worldY: number): NormalizedPoint | null => {
    const pixel = applyHomography(inverse, worldX + deltaAcrossM, worldY + deltaAlongM);
    if (!pixel) return null;
    return { x: pixel.x / frameWidth, y: pixel.y / frameHeight };
  };

  const topLeft = project(0, 0);
  const topRight = project(widthM, 0);
  const bottomRight = project(widthM, lengthM);
  const bottomLeft = project(0, lengthM);
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return null;

  return { topLeft, topRight, bottomRight, bottomLeft };
}

export function metricDisplacement(
  homography: Homography,
  fromX: number,
  fromY: number,
  dxPx: number,
  dyPx: number
): { distanceM: number; dxM: number; dyM: number } | null {
  const start = applyHomography(homography.forward, fromX, fromY);
  const end = applyHomography(homography.forward, fromX + dxPx, fromY + dyPx);
  if (!start || !end) return null;
  const dxM = end.x - start.x;
  const dyM = end.y - start.y;
  const distanceM = Math.hypot(dxM, dyM);
  return Number.isFinite(distanceM) ? { distanceM, dxM, dyM } : null;
}
