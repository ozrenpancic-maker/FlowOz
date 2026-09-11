import { median, medianAbsoluteDeviation, solveLinearSystem } from '../domain/linalg';
import type { NormalizedPoint, WaterRoi } from '../domain/types';
import { extractPatch, findPeak, prepareGrid, type Grid } from './ncc';
import { roiPolygon } from './roi';
import {
  SSIV_THRESHOLDS,
  type FramePair,
  type FramePairStabilisation,
  type SimilarityTransform,
} from './types';

/**
 * Camera-motion compensation.
 *
 * The operator is holding the phone, so the whole frame moves between the two
 * frames of a pair. The motion is measured on the stationary part of the scene
 * — everything outside the ROI — and removed from the water displacements.
 *
 * A hand does not only translate: it rolls. With three or more background
 * anchors the motion is fitted as a similarity (translation, rotation and a
 * touch of scale), so a small roll is subtracted properly instead of showing
 * up as anchors that "disagree" and failing the pair. With two anchors only a
 * translation can be checked, so that is all that is fitted. If the stationary
 * background cannot be tracked, or the fitted motion is not something a held
 * phone does between two frames, the pair is not stabilised and the run
 * reports UNSTABLE CAMERA rather than passing camera shake off as flow.
 */

/** How far background anchors may disagree with the fitted motion [px]. */
const MAX_ANCHOR_RESIDUAL_PX = 1.5;
/** A held phone does not zoom between two frames a tenth of a second apart. */
const MAX_SCALE_DEVIATION = 0.03;
/** Nor does it roll more than this [rad] (≈ 5°). */
const MAX_ROTATION_RAD = 0.087;

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

/** Sample positions on the stationary background: a grid of anchors outside the ROI. */
export function backgroundAnchors(roi: WaterRoi, width: number, height: number): { x: number; y: number }[] {
  const polygon = roiPolygon(roi);
  const anchors: { x: number; y: number }[] = [];
  // The correlation window plus its search radius has to fit inside the frame.
  const margin =
    Math.ceil(SSIV_THRESHOLDS.interrogationWindowPx / 2) + SSIV_THRESHOLDS.stabilisationSearchRadiusPx;

  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const nx = (col + 0.5) / 4;
      const ny = (row + 0.5) / 4;
      const x = nx * width;
      const y = ny * height;
      if (x < margin || y < margin || x > width - margin || y > height - margin) continue;
      if (pointInPolygon(polygon, nx, ny)) continue;
      anchors.push({ x, y });
    }
  }
  return anchors;
}

interface AnchorTrack {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** Where the transform sends a point. */
export function applySimilarity(t: SimilarityTransform, x: number, y: number): { x: number; y: number } {
  return { x: t.a * x - t.b * y + t.tx, y: t.b * x + t.a * y + t.ty };
}

/**
 * Least-squares similarity through a set of anchor tracks. Four unknowns, two
 * equations per anchor; the normal equations are solved directly.
 */
export function fitSimilarity(tracks: readonly AnchorTrack[]): SimilarityTransform | null {
  if (tracks.length < 2) return null;
  // Normal equations for [a, b, tx, ty].
  const ata = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const atb = [0, 0, 0, 0];
  const accumulate = (row: number[], target: number) => {
    for (let i = 0; i < 4; i += 1) {
      const ri = row[i] as number;
      atb[i] = (atb[i] as number) + ri * target;
      const line = ata[i] as number[];
      for (let j = 0; j < 4; j += 1) line[j] = (line[j] as number) + ri * (row[j] as number);
    }
  };
  for (const track of tracks) {
    accumulate([track.x, -track.y, 1, 0], track.x + track.dx);
    accumulate([track.y, track.x, 0, 1], track.y + track.dy);
  }
  const solution = solveLinearSystem(ata, atb);
  if (!solution) return null;
  const [a, b, tx, ty] = solution as [number, number, number, number];
  return { a, b, tx, ty };
}

function residuals(t: SimilarityTransform, tracks: readonly AnchorTrack[]): number[] {
  return tracks.map((track) => {
    const mapped = applySimilarity(t, track.x, track.y);
    return Math.hypot(mapped.x - (track.x + track.dx), mapped.y - (track.y + track.dy));
  });
}

/**
 * The camera-induced displacement at a point of the frame for a stabilised
 * pair — what has to be subtracted from a measured displacement there.
 */
export function cameraDisplacementAt(
  entry: Pick<FramePairStabilisation, 'stable' | 'model' | 'similarity' | 'shiftXPx' | 'shiftYPx'>,
  x: number,
  y: number
): { dx: number; dy: number } {
  if (!entry.stable) return { dx: 0, dy: 0 };
  if (entry.model === 'similarity' && entry.similarity) {
    const mapped = applySimilarity(entry.similarity, x, y);
    return { dx: mapped.x - x, dy: mapped.y - y };
  }
  return { dx: entry.shiftXPx, dy: entry.shiftYPx };
}

/**
 * Estimate the camera motion for one frame pair. `stable` is true only when
 * enough background anchors agree on one rigid motion at or above the
 * correlation floor.
 */
export function estimateCameraMotion(pair: FramePair, roi: WaterRoi): FramePairStabilisation {
  const first: Grid = { data: pair.first, width: pair.width, height: pair.height };
  const second = prepareGrid({ data: pair.second, width: pair.width, height: pair.height });
  const anchors = backgroundAnchors(roi, pair.width, pair.height);

  const tracks: AnchorTrack[] = [];
  const correlations: number[] = [];

  for (const anchor of anchors) {
    const patch = extractPatch(first, anchor.x, anchor.y, SSIV_THRESHOLDS.interrogationWindowPx);
    if (!patch) continue;
    const peak = findPeak(patch, second, anchor.x, anchor.y, SSIV_THRESHOLDS.stabilisationSearchRadiusPx);
    if (!peak) continue;
    correlations.push(peak.correlation);
    if (peak.correlation < SSIV_THRESHOLDS.minStabilisationCorrelation || peak.atSearchEdge) continue;
    tracks.push({ x: anchor.x, y: anchor.y, dx: peak.subDx, dy: peak.subDy });
  }

  const correlation = correlations.length > 0 ? median(correlations) : 0;
  const centreX = pair.width / 2;
  const centreY = pair.height / 2;
  const unstable = (anchorsUsed: number, residualPx: number): FramePairStabilisation => ({
    pairIndex: pair.index,
    shiftXPx: 0,
    shiftYPx: 0,
    model: 'translation',
    anchorsUsed,
    residualPx,
    correlation: Number.isFinite(correlation) ? correlation : 0,
    stable: false,
    frameDeltaS: pair.frameDeltaS,
  });

  if (tracks.length < 2 || correlation < SSIV_THRESHOLDS.minStabilisationCorrelation) {
    return unstable(tracks.length, Number.POSITIVE_INFINITY);
  }

  if (tracks.length >= 3) {
    // Similarity fit, with one chance to drop a single anchor that sits on
    // something that moved — a floating leaf, a shadow — provided enough
    // anchors remain to still check the fit.
    let used = tracks;
    let fit = fitSimilarity(used);
    let worst = fit ? residuals(fit, used) : [];
    if (fit && used.length >= 4 && Math.max(...worst) > MAX_ANCHOR_RESIDUAL_PX) {
      const drop = worst.indexOf(Math.max(...worst));
      const remaining = used.filter((_, index) => index !== drop);
      const refit = fitSimilarity(remaining);
      if (refit) {
        used = remaining;
        fit = refit;
        worst = residuals(refit, remaining);
      }
    }
    if (fit) {
      const residualPx = Math.max(...worst);
      const scale = Math.hypot(fit.a, fit.b);
      const rotationRad = Math.atan2(fit.b, fit.a);
      const plausible =
        Number.isFinite(scale) &&
        Math.abs(scale - 1) <= MAX_SCALE_DEVIATION &&
        Math.abs(rotationRad) <= MAX_ROTATION_RAD;
      if (!plausible || residualPx > MAX_ANCHOR_RESIDUAL_PX) {
        return unstable(used.length, residualPx);
      }
      const centre = applySimilarity(fit, centreX, centreY);
      return {
        pairIndex: pair.index,
        shiftXPx: centre.x - centreX,
        shiftYPx: centre.y - centreY,
        model: 'similarity',
        similarity: fit,
        rotationRad,
        scale,
        anchorsUsed: used.length,
        residualPx,
        correlation,
        stable: true,
        frameDeltaS: pair.frameDeltaS,
      };
    }
  }

  // Two anchors: only a translation can be checked. They have to agree.
  const shiftsX = tracks.map((track) => track.dx);
  const shiftsY = tracks.map((track) => track.dy);
  const shiftXPx = median(shiftsX);
  const shiftYPx = median(shiftsY);
  const spread = Math.max(
    medianAbsoluteDeviation(shiftsX, shiftXPx),
    medianAbsoluteDeviation(shiftsY, shiftYPx)
  );
  const residualPx = Math.max(
    ...tracks.map((track) => Math.hypot(track.dx - shiftXPx, track.dy - shiftYPx))
  );
  const stable =
    Number.isFinite(shiftXPx) && Number.isFinite(shiftYPx) && spread <= MAX_ANCHOR_RESIDUAL_PX;
  if (!stable) return unstable(tracks.length, residualPx);

  return {
    pairIndex: pair.index,
    shiftXPx,
    shiftYPx,
    model: 'translation',
    anchorsUsed: tracks.length,
    residualPx,
    correlation,
    stable: true,
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
