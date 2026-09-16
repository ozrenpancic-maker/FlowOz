import { err, ok, type Result } from '../domain/result';
import type { WaterRoi } from '../domain/types';
import { roiPolygon, toPixels } from './roi';

/**
 * Recovering a rectangle's real proportions from its perspective image.
 *
 * The streamwise length is the one number an operator cannot measure. A tape
 * lies across a channel easily enough, but there is nothing on open water to
 * stretch it along, so the figure gets estimated — and the estimate is the
 * whole scale. Two measurements of the same channel minutes apart came out
 * 6.7x apart from exactly this.
 *
 * It does not have to be measured. A rectangle photographed at an angle is
 * enough on its own: its two pairs of edges meet at two vanishing points, the
 * real-world directions behind them are perpendicular, and a pair of
 * perpendicular vanishing points fixes the focal length (assuming what holds
 * for a phone camera — square pixels, principal point at the centre of the
 * frame). With the focal length the plane's orientation follows, and with the
 * orientation the rectangle's proportions follow. This is standard metric
 * rectification — the same step a document scanner runs to flatten an A4
 * photographed from an angle.
 *
 * So the operator measures the channel width, which is easy and is needed for
 * the cross-section anyway, and the length is read off the geometry.
 *
 * Recovering the focal length this way needs both pairs of edges to converge.
 * A pair that stays parallel in the image has its vanishing point at infinity,
 * which pins the direction but says nothing about the focal length — and that
 * is not an exotic case: a phone held level and pointed straight down the
 * channel images the cross-stream edges as parallel horizontal lines, so the
 * quadrilateral comes out a symmetric trapezoid and the two unknowns collapse
 * to one equation. Turning the phone a few degrees off the channel axis, or
 * letting it roll slightly, breaks the symmetry and the method works.
 *
 * When the focal length is already known — a clip the app recorded itself can
 * read it from the camera — none of that applies: one equation is all the
 * aspect ratio needs, and every configuration resolves, symmetric trapezoid
 * and square-on shot included. So `rectifyRoi` takes it when it is available
 * and falls back to reading it off the quadrilateral when it is not.
 */

export type RectifyProblemCode =
  | 'EDGES_TOO_PARALLEL'
  | 'IMPLAUSIBLE_FOCAL_LENGTH'
  | 'DEGENERATE_QUADRILATERAL';

export interface RectifyProblem {
  code: RectifyProblemCode;
  detail: string;
}

export interface RectifiedRoi {
  /** Focal length used [px] — the one supplied, or the one the two vanishing
   * points implied. */
  focalLengthPx: number;
  /** Whether that focal length was read off the quadrilateral or handed in. */
  focalLengthSource: 'recovered' | 'known';
  /** Real streamwise length ÷ real cross-stream width of the ROI. */
  aspectRatio: number;
  /**
   * How far the two streamwise edges disagree about the length, as a fraction
   * of it. A true rectangle viewed through a pinhole gives zero; anything
   * larger is the quadrilateral not being the rectangle it was taken for.
   */
  edgeDisagreement: number;
}

type Vec3 = [number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Where two image lines meet, in homogeneous coordinates. The third component
 * is what says how far away: near zero means the lines are parallel on the
 * image and their meeting point is at infinity.
 */
function meet(p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3): Vec3 {
  return cross(cross(p1, p2), cross(p3, p4));
}

/**
 * Smallest convergence a vanishing point may show before it counts as no
 * convergence at all.
 *
 * Expressed as the angle between the two edges, not as a pixel distance, so
 * it means the same thing on any frame size. Half a degree over the length of
 * an edge is already a vanishing point several frame-widths away, where the
 * focal length it implies is dominated by where the operator's finger landed
 * rather than by the geometry.
 */
const MIN_CONVERGENCE_RAD = (0.5 * Math.PI) / 180;

function edgeAngle(from: Vec3, to: Vec3): number {
  return Math.atan2(to[1] - from[1], to[0] - from[0]);
}

function convergence(a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): number {
  let difference = edgeAngle(a1, a2) - edgeAngle(b1, b2);
  while (difference > Math.PI / 2) difference -= Math.PI;
  while (difference < -Math.PI / 2) difference += Math.PI;
  return Math.abs(difference);
}

/**
 * Focal lengths a phone camera can actually have, as a multiple of the frame
 * width. An ultrawide sits near 0.35, a main camera between 0.6 and 0.9, a
 * telephoto around 2. The band is generous on both sides because it is there
 * to catch a rectification that has gone wrong — a quadrilateral that was not
 * a rectangle, or corners placed carelessly — not to identify the lens.
 */
const MIN_FOCAL_FRACTION = 0.2;
const MAX_FOCAL_FRACTION = 6;

/**
 * The ROI's real proportions, read off its own perspective.
 *
 * The four corners are taken to be a rectangle lying on the water: the edges
 * 1–4 and 2–3 run downstream, the edges 1–2 and 4–3 cross the channel.
 */
export function rectifyRoi(
  roi: WaterRoi,
  frameWidth: number,
  frameHeight: number,
  knownFocalLengthPx?: number
): Result<RectifiedRoi, RectifyProblem> {
  if (!(frameWidth > 0) || !(frameHeight > 0)) {
    return err({ code: 'DEGENERATE_QUADRILATERAL', detail: `frame ${frameWidth}x${frameHeight}` });
  }
  const hasKnownFocal =
    knownFocalLengthPx !== undefined && Number.isFinite(knownFocalLengthPx) && knownFocalLengthPx > 0;

  const [topLeft, topRight, bottomRight, bottomLeft] = roiPolygon(roi).map((point) => {
    const pixel = toPixels(point, frameWidth, frameHeight);
    return [pixel.x, pixel.y, 1] as Vec3;
  }) as [Vec3, Vec3, Vec3, Vec3];

  const streamwiseConvergence = convergence(topLeft, bottomLeft, topRight, bottomRight);
  const crossConvergence = convergence(topLeft, topRight, bottomLeft, bottomRight);
  // Both pairs have to converge for the focal length to follow from the
  // quadrilateral alone. With one handed in, neither does.
  if (
    !hasKnownFocal &&
    (streamwiseConvergence < MIN_CONVERGENCE_RAD || crossConvergence < MIN_CONVERGENCE_RAD)
  ) {
    return err({
      code: 'EDGES_TOO_PARALLEL',
      detail:
        `edges converge by ${((streamwiseConvergence * 180) / Math.PI).toFixed(2)}° and ` +
        `${((crossConvergence * 180) / Math.PI).toFixed(2)}°; both pairs have to converge for ` +
        'the focal length to follow from the shape alone',
    });
  }

  const streamwiseVanishing = meet(topLeft, bottomLeft, topRight, bottomRight);
  const crossVanishing = meet(topLeft, topRight, bottomLeft, bottomRight);

  // A phone camera: square pixels, no skew, principal point at the centre of
  // the frame. Everything below rests on that and on nothing else.
  const centreX = frameWidth / 2;
  const centreY = frameHeight / 2;

  // Direction of each vanishing point from the principal point, as a ray. A
  // vanishing point at infinity is a direction parallel to the image plane,
  // which the third component being zero expresses exactly, so both cases are
  // handled by the same arithmetic.
  const toCentred = (v: Vec3): Vec3 => [v[0] - centreX * v[2], v[1] - centreY * v[2], v[2]];
  const a = toCentred(streamwiseVanishing);
  const b = toCentred(crossVanishing);

  // Perpendicular directions: (a - p)·(b - p) + f² w_a w_b = 0.
  let focalLengthPx: number;
  if (hasKnownFocal) {
    focalLengthPx = knownFocalLengthPx as number;
  } else {
    const planar = a[0] * b[0] + a[1] * b[1];
    const depth = a[2] * b[2];
    if (!Number.isFinite(planar) || !Number.isFinite(depth) || Math.abs(depth) < 1e-12) {
      return err({
        code: 'EDGES_TOO_PARALLEL',
        detail: 'one vanishing point sits at infinity, so the focal length is unconstrained',
      });
    }
    const focalSquared = -planar / depth;
    if (!(focalSquared > 0) || !Number.isFinite(focalSquared)) {
      return err({
        code: 'IMPLAUSIBLE_FOCAL_LENGTH',
        detail: `f² came out ${focalSquared.toFixed(1)}; the quadrilateral is not the image of a rectangle`,
      });
    }
    focalLengthPx = Math.sqrt(focalSquared);
    if (
      focalLengthPx < MIN_FOCAL_FRACTION * frameWidth ||
      focalLengthPx > MAX_FOCAL_FRACTION * frameWidth
    ) {
      return err({
        code: 'IMPLAUSIBLE_FOCAL_LENGTH',
        detail:
          `f = ${focalLengthPx.toFixed(0)} px on a ${frameWidth} px frame, outside what a phone ` +
          `camera has (${MIN_FOCAL_FRACTION}–${MAX_FOCAL_FRACTION}× the frame width)`,
      });
    }
  }

  // With the focal length known, each image point is a ray, the two edge
  // directions span the water plane, and their cross product is its normal.
  // Placing the plane at unit distance turns every corner into a 3D point —
  // up to one common scale, which cancels in a ratio of lengths.
  const ray = (p: Vec3): Vec3 => [(p[0] - centreX) / focalLengthPx, (p[1] - centreY) / focalLengthPx, 1];
  // The 3D direction a vanishing point stands for, written so that a point at
  // infinity needs no special case: its last component is simply zero, which
  // is exactly a direction parallel to the image plane.
  const direction = (centred: Vec3): Vec3 => [centred[0], centred[1], focalLengthPx * centred[2]];
  const normal = cross(direction(a), direction(b));

  const onPlane = (p: Vec3): Vec3 | null => {
    const r = ray(p);
    const scale = dot(normal, r);
    if (!Number.isFinite(scale) || Math.abs(scale) < 1e-12) return null;
    return [r[0] / scale, r[1] / scale, r[2] / scale];
  };

  const corners = [topLeft, topRight, bottomRight, bottomLeft].map(onPlane);
  if (corners.some((corner) => corner === null)) {
    return err({
      code: 'DEGENERATE_QUADRILATERAL',
      detail: 'a corner projects parallel to the water plane and has no position on it',
    });
  }
  const [spaceTopLeft, spaceTopRight, spaceBottomRight, spaceBottomLeft] = corners as [
    Vec3,
    Vec3,
    Vec3,
    Vec3,
  ];

  const leftEdge = distance(spaceTopLeft, spaceBottomLeft);
  const rightEdge = distance(spaceTopRight, spaceBottomRight);
  const topEdge = distance(spaceTopLeft, spaceTopRight);
  const bottomEdge = distance(spaceBottomLeft, spaceBottomRight);

  const length = (leftEdge + rightEdge) / 2;
  const width = (topEdge + bottomEdge) / 2;
  if (!(length > 0) || !(width > 0) || !Number.isFinite(length) || !Number.isFinite(width)) {
    return err({ code: 'DEGENERATE_QUADRILATERAL', detail: 'the rectified rectangle has no area' });
  }

  return ok({
    focalLengthPx,
    focalLengthSource: hasKnownFocal ? ('known' as const) : ('recovered' as const),
    aspectRatio: length / width,
    edgeDisagreement:
      (Math.abs(leftEdge - rightEdge) / length + Math.abs(topEdge - bottomEdge) / width) / 2,
  });
}
