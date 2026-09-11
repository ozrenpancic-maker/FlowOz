/**
 * Canonical display ↔ source-frame coordinate transform.
 *
 * Both the ROI editor (video) and Camera Level's rim/waterline point capture
 * let the operator tap on a preview that is scaled and possibly cropped
 * (`contentFit`/`resizeMode` "cover") or letterboxed ("contain") relative to
 * the actual video/photo pixels. A tap's on-screen position is only usable
 * evidence once converted into the same pixel frame the SSIV decoder or the
 * ellipse fit actually operates on — screen position and source position are
 * the same only when the preview's aspect ratio happens to exactly match the
 * source's, and even then only if nothing else offsets the content.
 *
 * This module is the single place that conversion happens, so every caller
 * — today's RoiEditor and Camera Level, and anything added later — maps a
 * point the same way, and that way is the one covered by the regression
 * tests below (multiple resolutions, orientations, both fit modes).
 */

export type FitMode = 'cover' | 'contain';

export interface FrameGeometry {
  /** Real pixel size of the video/photo being displayed. */
  sourceWidth: number;
  sourceHeight: number;
  /** Real pixel (or same-unit) size of the on-screen preview box. */
  displayWidth: number;
  displayHeight: number;
  /** How the source is fitted into the display box — mirrors
   * `contentFit`/`resizeMode` on the actual preview. */
  fit: FitMode;
}

export interface Point2D {
  x: number;
  y: number;
}

/**
 * The affine map from display pixels to source pixels for one frame
 * geometry: source = (display - offset) / scale.
 */
export interface DisplayMapping {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function isValidGeometry(geometry: FrameGeometry): boolean {
  return (
    Number.isFinite(geometry.sourceWidth) &&
    Number.isFinite(geometry.sourceHeight) &&
    Number.isFinite(geometry.displayWidth) &&
    Number.isFinite(geometry.displayHeight) &&
    geometry.sourceWidth > 0 &&
    geometry.sourceHeight > 0 &&
    geometry.displayWidth > 0 &&
    geometry.displayHeight > 0
  );
}

/**
 * The scale and offset `contentFit`/`resizeMode` actually apply. The same
 * formula covers both fit modes: `cover` picks the larger of the two axis
 * scales (so the source overflows the box and is cropped), `contain` picks
 * the smaller (so the source fits inside and the box is letterboxed) — the
 * resulting offset is then the crop amount (negative) or the letterbox bar
 * width (positive), in display pixels, for each axis independently.
 */
export function computeDisplayMapping(geometry: FrameGeometry): DisplayMapping | null {
  if (!isValidGeometry(geometry)) return null;
  const scaleX = geometry.displayWidth / geometry.sourceWidth;
  const scaleY = geometry.displayHeight / geometry.sourceHeight;
  const scale = geometry.fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offsetX = (geometry.displayWidth - geometry.sourceWidth * scale) / 2;
  const offsetY = (geometry.displayHeight - geometry.sourceHeight * scale) / 2;
  return { scale, offsetX, offsetY };
}

/**
 * Convert one point from display pixels (origin at the preview box's own
 * top-left) to source pixels (origin at the video/photo's own top-left).
 *
 * Returns null for a `contain`-fitted point that falls in the letterbox bar
 * — there is no source pixel under it — and for degenerate geometry (zero
 * or non-finite dimensions).
 */
export function displayToSource(point: Point2D, geometry: FrameGeometry): Point2D | null {
  const mapping = computeDisplayMapping(geometry);
  if (!mapping) return null;
  const x = (point.x - mapping.offsetX) / mapping.scale;
  const y = (point.y - mapping.offsetY) / mapping.scale;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (geometry.fit === 'contain' && (x < 0 || x > geometry.sourceWidth || y < 0 || y > geometry.sourceHeight)) {
    return null;
  }
  return { x, y };
}

/** The inverse of displayToSource — where one source pixel lands on screen. */
export function sourceToDisplay(point: Point2D, geometry: FrameGeometry): Point2D | null {
  const mapping = computeDisplayMapping(geometry);
  if (!mapping) return null;
  return {
    x: point.x * mapping.scale + mapping.offsetX,
    y: point.y * mapping.scale + mapping.offsetY,
  };
}

/**
 * Convenience wrapper for the common case: a tap normalised to the preview
 * box (0–1 of its own width/height, which is how touch handlers are usually
 * read) converted straight to a point normalised to the source frame (0–1 of
 * the video/photo's own width/height) — the representation ROI points and
 * Camera Level rim/waterline points are stored in.
 */
export function normalizedDisplayToSource(
  point: Point2D,
  geometry: Pick<FrameGeometry, 'sourceWidth' | 'sourceHeight' | 'fit'> & {
    displayWidth: number;
    displayHeight: number;
  }
): Point2D | null {
  const displayPoint = { x: point.x * geometry.displayWidth, y: point.y * geometry.displayHeight };
  const source = displayToSource(displayPoint, geometry);
  if (!source) return null;
  const x = source.x / geometry.sourceWidth;
  const y = source.y / geometry.sourceHeight;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** The inverse of normalizedDisplayToSource — for drawing a stored
 * source-normalised point (a ROI handle, a rim point) back onto the preview. */
export function normalizedSourceToDisplay(
  point: Point2D,
  geometry: Pick<FrameGeometry, 'sourceWidth' | 'sourceHeight' | 'fit'> & {
    displayWidth: number;
    displayHeight: number;
  }
): Point2D | null {
  const sourcePoint = { x: point.x * geometry.sourceWidth, y: point.y * geometry.sourceHeight };
  const display = sourceToDisplay(sourcePoint, geometry);
  if (!display) return null;
  return { x: display.x / geometry.displayWidth, y: display.y / geometry.displayHeight };
}
