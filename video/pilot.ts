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
  /**
   * Whether the camera's own motion could be measured at this spacing.
   *
   * A longer spacing gives the stationary scenery more time to stop looking
   * stationary — grass moves, light shifts, compression noise redraws fine
   * detail — so a rung can show a beautiful water displacement and still be
   * one the pipeline cannot use, because the shake underneath it could not be
   * subtracted. That is worth knowing before committing the real pass to it.
   */
  stabilised: boolean;
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
    stabilised: motion.stable,
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
 * If nothing qualifies the ladder still has something to say, but only in one
 * direction. Reaching for a LONGER spacing has to be earned: it is the right
 * move only when some rung actually measured the water moving, and measured it
 * moving less than a pixel. Absent that, a shorter spacing is the safe choice,
 * because spacing and travel go up together — whatever went wrong at the long
 * end (the water outran the search, or the surface stopped looking like itself
 * between the two frames) only gets worse further out.
 *
 * Getting this backwards is not hypothetical. A rung the water outruns does
 * not report a large displacement; it reports almost nothing, because nothing
 * correlates. The first version read that silence as "no rung was too fast"
 * and picked the longest spacing on the ladder — so two field clips ran at
 * 0.240 s and 0.480 s against a 0.005 m/px scale, where water near 0.8 m/s
 * travels 40 and 80 pixels between frames against a 24 pixel search range.
 * Both refused with correlation 0.47 and "rejected mostly LOW_CORRELATION".
 * At the ladder's shortest rung the same water moves about ten pixels, which
 * is squarely measurable.
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

  // A rung whose camera motion could not be measured is no use however good
  // its displacement looks, so those are set aside while any rung that did
  // stabilise remains. If none did, the run is going to fail on the camera
  // whatever is chosen, and the displacement is the only thing left to choose
  // on — better to fail with the spacing that at least saw the water.
  const trackable = qualified.filter((probe) => probe.stabilised);
  const preferred = trackable.length > 0 ? trackable : qualified;

  if (preferred.length > 0) {
    return preferred.reduce((best, probe) =>
      Math.abs(Math.log(probe.medianDisplacementPx / TARGET_DISPLACEMENT_PX)) <
      Math.abs(Math.log(best.medianDisplacementPx / TARGET_DISPLACEMENT_PX))
        ? probe
        : best
    );
  }

  // Positive evidence that the water was moving too little to see: a rung
  // that correlated well enough to measure a displacement, and measured one
  // under a pixel. Only that justifies going further out on the ladder.
  const measuredTooSlow = scored.some(
    (probe) =>
      probe.usableVectors >= SSIV_THRESHOLDS.minAcceptedVectors &&
      Number.isFinite(probe.medianDisplacementPx) &&
      probe.medianDisplacementPx < 1
  );
  return scored.reduce((best, probe) =>
    measuredTooSlow
      ? probe.frameDeltaS > best.frameDeltaS
        ? probe
        : best
      : probe.frameDeltaS < best.frameDeltaS
        ? probe
        : best
  );
}
