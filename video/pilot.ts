import { median } from '../domain/linalg';
import type { WaterRoi } from '../domain/types';
import { extractPatch, findPeak, prepareGrid, type Grid } from './ncc';
import { interrogationGrid } from './ssiv-core';
import { cameraDisplacementAt, estimateCameraMotion } from './stabilisation';
import { SSIV_THRESHOLDS, type FramePair } from './types';

/**
 * Choosing the frame spacing from the water instead of assuming it.
 *
 * Cross-correlation locates a displacement on a surface sampled at whole
 * pixels. How far the water travels between the two frames of a pair is
 * therefore the single number that decides whether a clip can be measured at
 * all, and it is not a property of the algorithm: it is the real velocity
 * times the frame spacing divided by the ROI's metric scale. Fix the spacing
 * in advance and that product is left to chance.
 *
 * It went badly. On a real channel — a 2 m reference length across a 240 px
 * working frame, water running near 0.4 m/s, spacing capped at 0.16 s — the
 * true displacement worked out at about one pixel. Every vector in the dump
 * sat between 0.00 and 0.17 px at correlations of 0.6 to 0.84: a peak pinned
 * at the origin, with the decimals coming from a parabola fitted through
 * three samples that differed by noise. The run reported 0.0020 m/s against a
 * real 0.4 m/s.
 *
 * So the spacing is measured rather than assumed. A handful of pairs are
 * decoded across a geometric ladder of spacings, the displacement each one
 * actually produces is read off, and the rung that lands closest to the
 * displacement correlation works best at is the one the real run uses. The
 * ladder's upper end needs no guess about how long a water surface stays
 * recognisable: a spacing long enough to lose the pattern shows up as
 * correlations under the floor and drops out on its own evidence.
 */

/**
 * Displacement the ladder aims for: a quarter of the interrogation window,
 * the long-standing PIV rule of thumb (Keane & Adrian). Far enough from zero
 * that the peak is located rather than interpolated, and far enough from the
 * window's edge that the two windows still share most of their pattern.
 */
export const TARGET_DISPLACEMENT_PX = SSIV_THRESHOLDS.interrogationWindowPx / 4;

/**
 * Displacement past which a spacing is rejected outright: the peak search
 * cannot follow further, so its answer is pinned at the edge of the search
 * range and says only "at least this much".
 */
const MAX_USABLE_DISPLACEMENT_PX = 0.75 * SSIV_THRESHOLDS.searchRadiusPx;

export interface SpacingProbe {
  /** Spacing this pair actually achieved [s]. */
  frameDeltaS: number;
  /** Median displacement of the water grid at that spacing [px]. */
  medianDisplacementPx: number;
  medianCorrelation: number;
  /** Grid nodes that correlated above the floor and stayed inside the search. */
  usableVectors: number;
  /** Nodes whose match sat on the border of the search range. */
  atSearchEdge: number;
}

/**
 * What one pair at one spacing says about the displacement. Camera motion is
 * removed the same way the real run removes it, so the figure is the water's
 * own travel and not the operator's hands.
 */
export function probeSpacing(pair: FramePair, roi: WaterRoi): SpacingProbe {
  const firstRaw: Grid = { data: pair.first, width: pair.width, height: pair.height };
  const second = prepareGrid({ data: pair.second, width: pair.width, height: pair.height });
  const motion = estimateCameraMotion(pair, roi);

  const displacements: number[] = [];
  const correlations: number[] = [];
  let atSearchEdge = 0;

  for (const node of interrogationGrid(roi)) {
    const x = node.point.x * pair.width;
    const y = node.point.y * pair.height;
    const patch = extractPatch(firstRaw, x, y, SSIV_THRESHOLDS.interrogationWindowPx);
    if (!patch) continue;
    const peak = findPeak(patch, second, x, y, SSIV_THRESHOLDS.searchRadiusPx);
    if (!peak) continue;
    correlations.push(peak.correlation);
    if (peak.atSearchEdge) {
      atSearchEdge += 1;
      continue;
    }
    if (peak.correlation < SSIV_THRESHOLDS.minCorrelation) continue;
    const camera = cameraDisplacementAt(motion, x, y);
    displacements.push(Math.hypot(peak.subDx - camera.dx, peak.subDy - camera.dy));
  }

  return {
    frameDeltaS: pair.frameDeltaS,
    medianDisplacementPx: displacements.length > 0 ? median(displacements) : Number.NaN,
    medianCorrelation: correlations.length > 0 ? median(correlations) : 0,
    usableVectors: displacements.length,
    atSearchEdge,
  };
}

/**
 * The spacing to run the real analysis at.
 *
 * A rung qualifies when enough of its grid correlated, the displacement it
 * produced is at least one whole pixel, and the search could still follow it.
 * Among those the closest to the target wins, compared as a ratio rather than
 * a difference because the ladder itself is geometric: 3 px and 12 px are
 * equally far from 6 px in the only sense that matters here.
 *
 * If nothing qualifies the ladder still has something to say. Displacements
 * everywhere below a pixel mean the longest spacing probed is the best chance
 * left; displacements everywhere past the search range mean the shortest is.
 * Returning nothing at all would only hand the decision back to the fixed
 * spacing that caused the problem.
 */
export function chooseSpacing(probes: readonly SpacingProbe[]): SpacingProbe | null {
  const scored = probes.filter(
    (probe) => Number.isFinite(probe.frameDeltaS) && probe.frameDeltaS > 0
  );
  if (scored.length === 0) return null;

  const qualified = scored.filter(
    (probe) =>
      probe.usableVectors >= SSIV_THRESHOLDS.minAcceptedVectors &&
      Number.isFinite(probe.medianDisplacementPx) &&
      probe.medianDisplacementPx >= 1 &&
      probe.medianDisplacementPx <= MAX_USABLE_DISPLACEMENT_PX
  );

  if (qualified.length > 0) {
    return qualified.reduce((best, probe) =>
      Math.abs(Math.log(probe.medianDisplacementPx / TARGET_DISPLACEMENT_PX)) <
      Math.abs(Math.log(best.medianDisplacementPx / TARGET_DISPLACEMENT_PX))
        ? probe
        : best
    );
  }

  const everyRungTooFast = scored.every(
    (probe) =>
      probe.atSearchEdge > probe.usableVectors ||
      (Number.isFinite(probe.medianDisplacementPx) &&
        probe.medianDisplacementPx > MAX_USABLE_DISPLACEMENT_PX)
  );
  return scored.reduce((best, probe) =>
    everyRungTooFast
      ? probe.frameDeltaS < best.frameDeltaS
        ? probe
        : best
      : probe.frameDeltaS > best.frameDeltaS
        ? probe
        : best
  );
}
