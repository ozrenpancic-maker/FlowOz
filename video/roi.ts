import type { KnownRoiDimensions, NormalizedPoint, WaterRoi } from '../domain/types';
import { SSIV_THRESHOLDS } from './types';

/**
 * ROI geometry checks. The ROI is a quadrilateral in normalised image
 * coordinates; its points are numbered 1–4 in the UI and flow runs from the top
 * edge (1–2) towards the bottom edge (4–3).
 */

export type RoiProblemCode =
  | 'NON_FINITE_POINT'
  | 'POINT_OUTSIDE_FRAME'
  | 'AREA_TOO_SMALL'
  | 'SELF_INTERSECTING'
  | 'WRONG_WINDING'
  | 'EXTREME_EDGE_RATIO'
  | 'NON_POSITIVE_PHYSICAL_DIMENSION';

export interface RoiProblem {
  code: RoiProblemCode;
  messageKey: string;
  detail?: string;
}

export const ROI_POINT_ORDER = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;
export type RoiPointKey = (typeof ROI_POINT_ORDER)[number];

/** ROI corners as a cyclic polygon: 1 → 2 → 3 → 4. */
export function roiPolygon(roi: WaterRoi): NormalizedPoint[] {
  return ROI_POINT_ORDER.map((key) => roi[key]);
}

export function defaultRoi(): WaterRoi {
  return {
    topLeft: { x: 0.25, y: 0.3 },
    topRight: { x: 0.75, y: 0.3 },
    bottomRight: { x: 0.75, y: 0.7 },
    bottomLeft: { x: 0.25, y: 0.7 },
  };
}

/** Shoelace area of the ROI, as a fraction of the frame. Signed. */
export function signedArea(roi: WaterRoi): number {
  const points = roiPolygon(roi);
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as NormalizedPoint;
    const b = points[(i + 1) % points.length] as NormalizedPoint;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function segmentsIntersect(
  p1: NormalizedPoint,
  p2: NormalizedPoint,
  p3: NormalizedPoint,
  p4: NormalizedPoint
): boolean {
  const orientation = (a: NormalizedPoint, b: NormalizedPoint, c: NormalizedPoint) => {
    const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
    if (Math.abs(value) < 1e-12) return 0;
    return value > 0 ? 1 : 2;
  };
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  return o1 !== o2 && o3 !== o4;
}

/** A "bow-tie" quadrilateral, where the two opposite edges cross. */
export function isSelfIntersecting(roi: WaterRoi): boolean {
  const [p1, p2, p3, p4] = roiPolygon(roi) as [
    NormalizedPoint,
    NormalizedPoint,
    NormalizedPoint,
    NormalizedPoint,
  ];
  return segmentsIntersect(p1, p2, p3, p4) || segmentsIntersect(p2, p3, p4, p1);
}

export function edgeLengths(roi: WaterRoi): number[] {
  const points = roiPolygon(roi);
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length] as NormalizedPoint;
    return Math.hypot(next.x - point.x, next.y - point.y);
  });
}

/**
 * Validate the ROI on its own, before any homography is attempted. Returns
 * every problem found so the operator can fix them in one pass instead of
 * discovering them one at a time.
 */
export function validateRoi(roi: WaterRoi, dimensions?: KnownRoiDimensions): RoiProblem[] {
  const problems: RoiProblem[] = [];
  const points = roiPolygon(roi);

  for (const [index, point] of points.entries()) {
    const label = `P${index + 1}`;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      problems.push({
        code: 'NON_FINITE_POINT',
        messageKey: 'roi.error.NON_FINITE_POINT',
        detail: label,
      });
      continue;
    }
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      problems.push({
        code: 'POINT_OUTSIDE_FRAME',
        messageKey: 'roi.error.POINT_OUTSIDE_FRAME',
        detail: `${label} (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`,
      });
    }
  }

  if (problems.some((problem) => problem.code === 'NON_FINITE_POINT')) {
    return problems;
  }

  if (isSelfIntersecting(roi)) {
    problems.push({ code: 'SELF_INTERSECTING', messageKey: 'roi.error.SELF_INTERSECTING' });
  }

  const area = signedArea(roi);
  // Walking 1→2→3→4 across the top edge and back along the bottom gives a
  // positive shoelace area in image coordinates (x right, y down). The opposite
  // sign means the corners were entered in the wrong order.
  if (area < 0) {
    problems.push({ code: 'WRONG_WINDING', messageKey: 'roi.error.WRONG_WINDING' });
  }
  if (Math.abs(area) < SSIV_THRESHOLDS.minRoiAreaFraction) {
    problems.push({
      code: 'AREA_TOO_SMALL',
      messageKey: 'roi.error.AREA_TOO_SMALL',
      detail: `${Math.abs(area).toFixed(4)} < ${SSIV_THRESHOLDS.minRoiAreaFraction}`,
    });
  }

  const lengths = edgeLengths(roi);
  const shortest = Math.min(...lengths);
  const longest = Math.max(...lengths);
  if (shortest <= 1e-6 || longest / shortest > 12) {
    problems.push({
      code: 'EXTREME_EDGE_RATIO',
      messageKey: 'roi.error.EXTREME_EDGE_RATIO',
      detail: `${longest.toFixed(3)} / ${shortest.toFixed(3)}`,
    });
  }

  if (dimensions) {
    for (const [field, value] of [
      ['widthM', dimensions.widthM],
      ['lengthM', dimensions.lengthM],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        problems.push({
          code: 'NON_POSITIVE_PHYSICAL_DIMENSION',
          messageKey: 'roi.error.NON_POSITIVE_PHYSICAL_DIMENSION',
          detail: `${field}=${value}`,
        });
      }
    }
  }

  return problems;
}

/** Convert a normalised ROI point to working-resolution pixels. */
export function toPixels(point: NormalizedPoint, width: number, height: number) {
  return { x: point.x * width, y: point.y * height };
}
