import type { Point2D } from './ellipse';

/**
 * The water-line as a line (not two independently-placed points), stored in
 * the photo's own source pixels.
 *
 * `estimateDepthFromRim` (domain/ellipse.ts) is unchanged by this module: it
 * still takes two points and averages their projections onto the rim's
 * "down" axis. Because that projection is linear, the average of the two
 * endpoints' projections equals the projection of their midpoint whenever
 * the endpoints are placed symmetrically about it — which `toEndpoints`
 * always does. So a WaterLine is geometrically equivalent to the old
 * two-point model for any `halfLengthPx`: only `midpoint` and `angleRad`
 * carry hydraulic meaning, and `halfLengthPx` is cosmetic (how long the drawn
 * line looks).
 */
export interface WaterLine {
  /** Line midpoint, in source pixels. */
  midpoint: Point2D;
  /** Direction of the line from +x, radians, in source-pixel space. */
  angleRad: number;
  /** Half-length of the drawn line, in source pixels — cosmetic only. */
  halfLengthPx: number;
}

/** The two endpoints `estimateDepthFromRim` and CameraLevelEvidence expect. */
export function toEndpoints(line: WaterLine): [Point2D, Point2D] {
  const dx = Math.cos(line.angleRad) * line.halfLengthPx;
  const dy = Math.sin(line.angleRad) * line.halfLengthPx;
  return [
    { x: line.midpoint.x - dx, y: line.midpoint.y - dy },
    { x: line.midpoint.x + dx, y: line.midpoint.y + dy },
  ];
}

/**
 * Suggest an initial line: centred on the fitted rim, drawn perpendicular to
 * "down" so it starts looking like a plausible water surface. This is only a
 * starting point — gravity never constrains the manual drag/rotate that
 * follows, and an operator with a level phone but a genuinely tilted water
 * line (e.g. a sloped invert) is free to rotate it away from this guess.
 */
export function suggestInitialWaterLine(
  fit: { centre: Point2D; semiMajor: number },
  gravity?: { x: number; y: number }
): WaterLine {
  const gx = gravity && Number.isFinite(gravity.x) ? gravity.x : 0;
  const gy = gravity && Number.isFinite(gravity.y) ? gravity.y : 1;
  const gLength = Math.hypot(gx, gy) || 1;
  const downX = gx / gLength;
  const downY = gy / gLength;
  // Perpendicular to "down": a line running across the pipe, the way a level
  // water surface would sit.
  const angleRad = Math.atan2(downX, -downY);
  const halfLengthPx = Math.abs(fit.semiMajor) * 1.3 || 1;
  return { midpoint: { ...fit.centre }, angleRad, halfLengthPx };
}
