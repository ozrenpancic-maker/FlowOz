import { median, medianAbsoluteDeviation, solveLinearSystem } from '../domain/linalg';
import type { NormalizedPoint, WaterRoi } from '../domain/types';
import { extractPatch, findPeak, prepareGrid, type Grid } from './ncc';
import { roiPolygon } from './roi';
import {
  SSIV_THRESHOLDS,
  type AnchorDiagnostic,
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

/**
 * Sample positions on the stationary background: a grid of anchors outside the
 * ROI.
 *
 * An anchor is only usable where its whole correlation window *plus* its whole
 * search range fits inside the frame, which is a `margin` band around the edge.
 * A grid position that lands inside that band is nudged in to the nearest
 * usable spot rather than thrown away: it is still a perfectly good sample of
 * the stationary scene a few pixels further in, and throwing it away costs an
 * entire row or column of the grid.
 *
 * That cost was not hypothetical. At the working resolution the frames are
 * actually analysed at (240 px wide, so 135 px tall for 16:9) the margin is
 * 24 px, and the grid's own top and bottom rows sit at y = 16.9 and y = 118.1
 * — both inside the band. Discarding them left a 4x2 grid confined to the
 * vertical middle of the frame, which on any normal shot of a channel running
 * across the view is exactly where the water, and therefore the ROI, is. A
 * realistically drawn ROI then left two anchors in one vertical line, below
 * the three a rotation fit needs and one bad correlation away from no
 * stabilisation at all — on every pair, whatever the operator did with the
 * ROI. Nudging instead of discarding puts the top and bottom rows back on the
 * banks, where the stationary texture actually is.
 *
 * Membership of the ROI is tested at the nudged position, not the original
 * one, so an anchor that moves into the ROI is still correctly rejected.
 */
export function backgroundAnchors(roi: WaterRoi, width: number, height: number): { x: number; y: number }[] {
  const polygon = roiPolygon(roi);
  const anchors: { x: number; y: number }[] = [];
  // The correlation window plus its search radius has to fit inside the frame.
  const margin =
    Math.ceil(SSIV_THRESHOLDS.interrogationWindowPx / 2) + SSIV_THRESHOLDS.stabilisationSearchRadiusPx;
  // Nothing fits: a frame this small has no position where a full search can
  // be run, and pretending otherwise would report a motion measured off the
  // edge of the image.
  if (width < 2 * margin || height < 2 * margin) return [];

  const seen = new Set<string>();
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const x = Math.min(Math.max(((col + 0.5) / 4) * width, margin), width - margin);
      const y = Math.min(Math.max(((row + 0.5) / 4) * height, margin), height - margin);
      if (pointInPolygon(polygon, x / width, y / height)) continue;
      // Two grid positions can be nudged onto the same spot on a frame barely
      // larger than the margins; one anchor there is one piece of evidence,
      // not two, and counting it twice would let a single patch outvote the
      // others in the fit.
      const key = `${x.toFixed(3)},${y.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
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

function residualOf(t: SimilarityTransform, track: AnchorTrack): number {
  const mapped = applySimilarity(t, track.x, track.y);
  return Math.hypot(mapped.x - (track.x + track.dx), mapped.y - (track.y + track.dy));
}

function residuals(t: SimilarityTransform, tracks: readonly AnchorTrack[]): number[] {
  return tracks.map((track) => residualOf(t, track));
}

/**
 * The largest set of anchors that agree on one rigid motion.
 *
 * "Everything outside the ROI is stationary" is an assumption, not a fact.
 * Water carries on past the ROI's edge, a leaf floats through, a shadow
 * drifts — each puts an anchor into the set that is faithfully tracking
 * something that really moved. Fitting every anchor and then dropping the
 * single worst one survives exactly one such anchor; past that, the outliers
 * drag the fit far enough that every anchor looks wrong and the pair is
 * thrown away as "unstable camera" even though most of the frame was
 * perfectly still.
 *
 * The motion is chosen by consensus instead. Two anchors determine a
 * similarity exactly — four unknowns, four equations — so every pair of
 * anchors is one hypothesis, and the hypothesis the most anchors agree with
 * inside MAX_ANCHOR_RESIDUAL_PX wins. The enumeration is exhaustive over
 * anchor pairs rather than sampled, so the same clip always yields the same
 * motion; with at most sixteen anchors it is also cheap.
 */
function consensusTracks(tracks: readonly AnchorTrack[]): AnchorTrack[] {
  let best: AnchorTrack[] = [];
  let bestError = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tracks.length; i += 1) {
    for (let j = i + 1; j < tracks.length; j += 1) {
      const hypothesis = fitSimilarity([tracks[i] as AnchorTrack, tracks[j] as AnchorTrack]);
      if (!hypothesis) continue;
      const inliers: AnchorTrack[] = [];
      let error = 0;
      for (const track of tracks) {
        const residual = residualOf(hypothesis, track);
        if (!Number.isFinite(residual) || residual > MAX_ANCHOR_RESIDUAL_PX) continue;
        inliers.push(track);
        error += residual;
      }
      // More agreement wins; on a tie the tighter agreement does, so the
      // result does not depend on which pair happened to be enumerated first.
      if (inliers.length > best.length || (inliers.length === best.length && error < bestError)) {
        best = inliers;
        bestError = error;
      }
    }
  }
  return best;
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
  const candidateCorrelations: number[] = [];
  const trackedCorrelations: number[] = [];
  let atSearchEdge = 0;

  for (const anchor of anchors) {
    const patch = extractPatch(first, anchor.x, anchor.y, SSIV_THRESHOLDS.interrogationWindowPx);
    if (!patch) continue;
    const peak = findPeak(patch, second, anchor.x, anchor.y, SSIV_THRESHOLDS.stabilisationSearchRadiusPx);
    if (!peak) continue;
    candidateCorrelations.push(peak.correlation);
    if (peak.atSearchEdge) atSearchEdge += 1;
    if (peak.correlation < SSIV_THRESHOLDS.minStabilisationCorrelation || peak.atSearchEdge) continue;
    trackedCorrelations.push(peak.correlation);
    tracks.push({ x: anchor.x, y: anchor.y, dx: peak.subDx, dy: peak.subDy });
  }

  // The correlation the stabilisation rests on is the one of the anchors it
  // kept. Every anchor below the floor was already dropped in the loop above;
  // judging the pair a second time on a median that still includes them is
  // double jeopardy, and it fails pairs that had perfectly good evidence.
  //
  // Field evidence: twelve anchor positions offered, four or five tracking
  // cleanly, none past the edge of the search range — and the pair refused
  // anyway, because the other seven sat on grass and wet stone whose weaker
  // correlations pulled the median over all twelve to 0.47, under the 0.55
  // floor. One pair of six survived a clip shot off a steady rest. Sampling
  // the banks more thoroughly made this worse rather than better, which is
  // the wrong way round for more evidence.
  const correlation = trackedCorrelations.length > 0 ? median(trackedCorrelations) : 0;
  const candidateCorrelation =
    candidateCorrelations.length > 0 ? median(candidateCorrelations) : 0;
  const centreX = pair.width / 2;
  const centreY = pair.height / 2;

  // Every anchor offered, tagged with whether it ended up in `used` — the set
  // that actually fed the reported motion. An anchor that merely tracked
  // above the floor but was outvoted by the consensus, or that tracked fine
  // in a pair reported unstable overall, is not "used": the point is what the
  // report trusted, not what individually correlated.
  const anchorDiagnostics = (used: readonly AnchorTrack[]): AnchorDiagnostic[] => {
    const usedKeys = new Set(used.map((track) => `${track.x},${track.y}`));
    return anchors.map((anchor) => ({
      x: anchor.x,
      y: anchor.y,
      used: usedKeys.has(`${anchor.x},${anchor.y}`),
    }));
  };

  const unstable = (anchorsUsed: number, residualPx: number): FramePairStabilisation => ({
    pairIndex: pair.index,
    anchors: anchorDiagnostics([]),
    shiftXPx: 0,
    shiftYPx: 0,
    model: 'translation',
    anchorsAvailable: anchors.length,
    anchorsAtSearchEdge: atSearchEdge,
    anchorsUsed,
    residualPx,
    correlation: Number.isFinite(correlation) ? correlation : 0,
    candidateCorrelation: Number.isFinite(candidateCorrelation) ? candidateCorrelation : 0,
    stable: false,
    frameDeltaS: pair.frameDeltaS,
  });

  if (tracks.length < 2) {
    return unstable(tracks.length, Number.POSITIVE_INFINITY);
  }

  // The consensus has to be a majority of the anchors that tracked, not just
  // three of them. Any three points can be talked into agreeing on some
  // similarity, so "three agree" on its own would let a corner of a frame that
  // is warping non-rigidly — real shake, rolling shutter — pass as one clean
  // camera motion. Requiring most of the evidence to fit means the model
  // describes the frame rather than a fragment of it.
  const consensus = tracks.length >= 3 ? consensusTracks(tracks) : tracks;
  if (consensus.length >= 3 && consensus.length * 2 > tracks.length) {
    // Refit over the anchors that agreed, so the reported motion uses all of
    // their evidence rather than the two that seeded the hypothesis.
    const used = consensus;
    const fit = fitSimilarity(used);
    if (fit) {
      const residualPx = Math.max(...residuals(fit, used));
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
        anchors: anchorDiagnostics(used),
        shiftXPx: centre.x - centreX,
        shiftYPx: centre.y - centreY,
        model: 'similarity',
        similarity: fit,
        rotationRad,
        scale,
        anchorsAvailable: anchors.length,
        anchorsAtSearchEdge: atSearchEdge,
        anchorsUsed: used.length,
        residualPx,
        correlation,
        candidateCorrelation,
        stable: true,
        frameDeltaS: pair.frameDeltaS,
      };
    }
  }

  // Too few anchors agreed for a rotation to be checked: only a translation
  // can be, and the anchors that are left have to agree on it.
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
    anchors: anchorDiagnostics(tracks),
    shiftXPx,
    shiftYPx,
    model: 'translation',
    anchorsAvailable: anchors.length,
    anchorsAtSearchEdge: atSearchEdge,
    anchorsUsed: tracks.length,
    residualPx,
    correlation,
    candidateCorrelation,
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
