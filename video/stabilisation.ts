import { median, medianAbsoluteDeviation } from '../domain/linalg';
import type { NormalizedPoint, WaterRoi } from '../domain/types';
import { extractPatch, findPeak, prepareGrid, type Grid } from './ncc';
import { roiPolygon } from './roi';
import { SSIV_THRESHOLDS, type FramePair, type FramePairStabilisation } from './types';

/**
 * Camera-motion compensation.
 *
 * The operator is holding the phone, so the whole frame drifts between the two
 * frames of a pair. The drift is measured on the stationary part of the scene —
 * everything outside the ROI — and subtracted from the water displacements. If
 * the stationary background cannot be tracked, the pair is not stabilised and
 * the run reports UNSTABLE CAMERA rather than passing camera shake off as flow.
 */

/** How far background anchors may disagree about the global shift [px]. */
const MAX_ANCHOR_DISAGREEMENT_PX = 1.5;

function pointInPolygon(polygon: readonly NormalizedPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as NormalizedPoint;
    const b = polygon[j] as NormalizedPoint;
    const intersects = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Sample positions on the stationary background: a ring of anchors outside the ROI. */
export function backgroundAnchors(roi: WaterRoi, width: number, height: number): { x: number; y: number }[] {
  const polygon = roiPolygon(roi);
  const anchors: { x: number; y: number }[] = [];
  const margin = SSIV_THRESHOLDS.interrogationWindowPx;

  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const nx = (col + 0.5) / 4;
      const ny = (row + 0.5) / 4;
      // Keep a margin so the correlation window plus its search radius fits.
      const x = nx * width;
      const y = ny * height;
      if (x < margin || y < margin || x > width - margin || y > height - margin) continue;
      if (pointInPolygon(polygon, nx, ny)) continue;
      anchors.push({ x, y });
    }
  }
  return anchors;
}

/**
 * Estimate the global camera displacement for one frame pair. `stable` is true
 * only when enough background anchors agree at or above the correlation floor.
 */
export function estimateCameraMotion(pair: FramePair, roi: WaterRoi): FramePairStabilisation {
  const first: Grid = { data: pair.first, width: pair.width, height: pair.height };
  const second = prepareGrid({ data: pair.second, width: pair.width, height: pair.height });
  const anchors = backgroundAnchors(roi, pair.width, pair.height);

  const shiftsX: number[] = [];
  const shiftsY: number[] = [];
  const correlations: number[] = [];

  for (const anchor of anchors) {
    const patch = extractPatch(first, anchor.x, anchor.y, SSIV_THRESHOLDS.interrogationWindowPx);
    if (!patch) continue;
    const peak = findPeak(patch, second, anchor.x, anchor.y, SSIV_THRESHOLDS.searchRadiusPx);
    if (!peak) continue;
    if (peak.correlation < SSIV_THRESHOLDS.minStabilisationCorrelation) {
      correlations.push(peak.correlation);
      continue;
    }
    shiftsX.push(peak.subDx);
    shiftsY.push(peak.subDy);
    correlations.push(peak.correlation);
  }

  // A pair is stabilised only when the background anchors AGREE on one rigid
  // displacement. Two anchors are the minimum — a single tracked patch could
  // itself be something that moved — and their spread has to be small, because
  // scattered "shifts" mean the frame is not undergoing a rigid motion at all
  // (rolling shutter, motion blur, or a spurious match on weak texture).
  const tracked = shiftsX.length;
  const shiftXPx = tracked > 0 ? median(shiftsX) : 0;
  const shiftYPx = tracked > 0 ? median(shiftsY) : 0;
  const correlation = correlations.length > 0 ? median(correlations) : 0;

  const spreadX = tracked > 1 ? medianAbsoluteDeviation(shiftsX, shiftXPx) : 0;
  const spreadY = tracked > 1 ? medianAbsoluteDeviation(shiftsY, shiftYPx) : 0;
  const spread = Math.max(Number.isFinite(spreadX) ? spreadX : 0, Number.isFinite(spreadY) ? spreadY : 0);

  const stable =
    tracked >= 2 &&
    Number.isFinite(shiftXPx) &&
    Number.isFinite(shiftYPx) &&
    correlation >= SSIV_THRESHOLDS.minStabilisationCorrelation &&
    spread <= MAX_ANCHOR_DISAGREEMENT_PX;

  return {
    pairIndex: pair.index,
    shiftXPx: stable ? shiftXPx : 0,
    shiftYPx: stable ? shiftYPx : 0,
    correlation: Number.isFinite(correlation) ? correlation : 0,
    stable,
    frameDeltaS: pair.frameDeltaS,
  };
}

/**
 * A frame with no ROI at all (an empty scene) still has to be handled: if no
 * anchor could be extracted, the pair is reported unstable, not silently
 * accepted with a zero shift.
 */
export function stabiliseAll(pairs: readonly FramePair[], roi: WaterRoi): FramePairStabilisation[] {
  return pairs.map((pair) => estimateCameraMotion(pair, roi));
}
