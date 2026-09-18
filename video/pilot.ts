import { median } from '../domain/linalg';
import type { WaterRoi } from '../domain/types';
import { suppressStaticBackground } from './background';
import { extractPatch, findPeak, prepareGrid, type Grid } from './ncc';
import { interrogationGrid, roiPixelBoundingBox } from './ssiv-core';
import { cameraDisplacementAt, estimateCameraMotion } from './stabilisation';
import { SSIV_THRESHOLDS, type FramePair, type FramePairStabilisation } from './types';

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
export function probeSpacing(
  pair: FramePair,
  roi: WaterRoi,
  /**
   * The camera's own motion for this pair, when it was measured elsewhere.
   *
   * It has to be, whenever the frames handed in here have had their static
   * background subtracted: the anchors live outside the ROI, on exactly the
   * scenery that subtraction flattens to nothing, so re-measuring the motion
   * from those frames tracks noise. Measured on a synthetic clip of water
   * crossing 6 px over a visible bed, the peak was found at 6.02 px and then
   * a phantom camera motion of 5.84 px was subtracted from it, leaving 0.40.
   */
  precomputedMotion?: FramePairStabilisation
): SpacingProbe {
  const firstRaw: Grid = { data: pair.first, width: pair.width, height: pair.height };
  const second = prepareGrid({ data: pair.second, width: pair.width, height: pair.height });
  const motion = precomputedMotion ?? estimateCameraMotion(pair, roi);

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
 * Probe every rung of the ladder the way the real run measures.
 *
 * Two things have to happen in the order the analysis does them, and getting
 * either wrong sends the ladder to the opposite end from the right answer.
 *
 * The streambed is removed first. A stone channel with the bed showing
 * through holds a stronger, better-defined pattern than the ripples running
 * over it, and it does not move — so most of the grid locks onto it at zero
 * displacement and the median reads "the water is barely moving" however fast
 * it runs. On synthetic water crossing 6 px over a visible bed the raw probe
 * returned 0.41 px. The real run never had this problem because it has always
 * interrogated the suppressed frames; only the pilot was reading the bed.
 *
 * The camera's motion is measured BEFORE that removal, on the raw frames.
 * Its anchors sit outside the ROI, on the bank and the stones — the very
 * scenery the subtraction erases. Measured after it, the same clip reported a
 * camera moving 5.84 px, which then cancelled the water's own 6.02 px and
 * left 0.40.
 *
 * Both together: 6.02 px found, 5.95 px reported, against a true 6.
 *
 * This was the field failure. Clip after clip on a channel independently
 * timed at 0.83 m/s had the pilot read tenths of a pixel at the shortest
 * rung, disqualify it for being sub-pixel, and walk out to 0.96 s — where
 * that water travels over a hundred pixels against a 24 px search and
 * nothing correlates at all.
 */
export function probeLadder(pairs: readonly FramePair[], roi: WaterRoi): SpacingProbe[] {
  const motions = pairs.map((pair) => estimateCameraMotion(pair, roi));
  const reference = pairs[0];
  const suppressed = suppressStaticBackground(
    pairs,
    reference ? roiPixelBoundingBox(roi, reference.width, reference.height) : undefined
  );
  return suppressed.pairs.map((pair, index) => probeSpacing(pair, roi, motions[index]));
}

/**
 * One line per rung of the ladder, for a run to say exactly what the pilot
 * saw and why it chose what it chose — rather than leaving that to be
 * reverse-engineered from the final run's numbers after the fact.
 *
 * This exists because it was needed: a field clip's frame spacing kept coming
 * back at the ladder's longest rung on water independently known to run
 * 0.5-0.9 m/s, and nothing recorded what every OTHER rung had measured to
 * explain why. A synthetic clip built to reproduce it — a visible streambed
 * under real fast-moving water — did not reproduce the failure; the pilot
 * chose correctly on that model. Something about the real clip differs from
 * every model tried so far, and the next field report needs to carry the
 * actual per-rung numbers rather than requiring another guess.
 */
export function describeSpacingProbes(
  probes: readonly SpacingProbe[],
  chosen: SpacingProbe | null
): string {
  const rows = probes
    .map((probe) => {
      const marker = chosen && probe.frameDeltaS === chosen.frameDeltaS ? '*' : ' ';
      return (
        `${marker}dt=${probe.frameDeltaS.toFixed(3)}s ` +
        `d=${Number.isFinite(probe.medianDisplacementPx) ? probe.medianDisplacementPx.toFixed(2) : '—'}px ` +
        `c=${probe.medianCorrelation.toFixed(2)} n=${probe.usableVectors} edge=${probe.atSearchEdge} ` +
        `stable=${probe.stabilised ? 'y' : 'n'}`
      );
    })
    .join('; ');
  return `pilot ladder (* chosen): ${rows}`;
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
      probe.medianDisplacementPx <= MAX_USABLE_DISPLACEMENT_PX &&
      // A rung already correlating below the floor cannot clear that same
      // floor in the real run — every vector it produces is rejected by
      // definition, so running there is a guaranteed refusal however well
      // placed its displacement looks. Choosing on displacement alone did
      // exactly that on a field clip: the 0.120 s rung won at correlation
      // 0.27 with four usable vectors, over a 0.060 s rung sitting at 0.39
      // with fourteen, and the run returned one vector out of a hundred.
      probe.medianCorrelation >= SSIV_THRESHOLDS.minCorrelation
  );

  // Travel and time go together, so the rungs that are measuring the same
  // water all imply the same velocity. A rung the water has outrun does not:
  // its peak is somewhere inside the search range with no relation to the
  // motion, and the velocity it implies comes back an order of magnitude
  // short. Reading it as a displacement near the target is how a ladder ends
  // up running at a spacing whose own ceiling is below the water's speed.
  //
  // Two field ladders from one stream, with the rung chosen on displacement
  // alone marked:
  //
  //   2.54 px @ 0.060 s → 42 px/s      2.10 px @ 0.060 s → 35 px/s
  //  *2.56 px @ 0.960 s →  3 px/s     *3.63 px @ 0.960 s →  4 px/s
  //
  // Both ran at 0.960 s, where the ceiling was 0.16 and 0.10 m/s against
  // water measured at 0.28. The same displacement at sixteen times the gap
  // is the proof it is not motion.
  //
  // Half the best rung's implied velocity is a generous line — those wrong
  // rungs came back nine to sixteen times short — and it leaves rungs that
  // genuinely disagree a little to be settled on displacement as before.
  const impliedVelocity = (probe: SpacingProbe) => probe.medianDisplacementPx / probe.frameDeltaS;
  const fastestImplied = qualified.reduce(
    (best, probe) => Math.max(best, impliedVelocity(probe)),
    0
  );
  const consistent = qualified.filter((probe) => impliedVelocity(probe) >= fastestImplied / 2);

  // A rung whose camera motion could not be measured is no use however good
  // its displacement looks, so those are set aside while any rung that did
  // stabilise remains. If none did, the run is going to fail on the camera
  // whatever is chosen, and the displacement is the only thing left to choose
  // on — better to fail with the spacing that at least saw the water.
  const trackable = consistent.filter((probe) => probe.stabilised);
  const preferred = trackable.length > 0 ? trackable : consistent;

  if (preferred.length > 0) {
    return preferred.reduce((best, probe) =>
      Math.abs(Math.log(probe.medianDisplacementPx / TARGET_DISPLACEMENT_PX)) <
      Math.abs(Math.log(best.medianDisplacementPx / TARGET_DISPLACEMENT_PX))
        ? probe
        : best
    );
  }

  // Going further out on the ladder is only right for water genuinely moving
  // too little to see, and sub-pixel travel on its own does not say that.
  // Correlation locking onto a streambed showing through the water also sits
  // at zero displacement — at every spacing, because the bed does not move —
  // and reading that as "barely moving" is what sent field clips out to
  // 0.480 s and 0.960 s on water crossing seventy pixels between frames.
  //
  // What separates them is whether the travel GROWS with the spacing. Real
  // motion covers twice the distance in twice the time; a lock on something
  // stationary covers the same nothing however long you wait. So the rungs
  // that saw anything are compared end to end, and the ladder only reaches
  // further out when doubling the gap between frames actually bought more
  // travel.
  const informative = scored.filter(
    (probe) =>
      probe.usableVectors >= SSIV_THRESHOLDS.minAcceptedVectors &&
      Number.isFinite(probe.medianDisplacementPx)
  );
  const shortest = informative.reduce<SpacingProbe | null>(
    (best, probe) => (best === null || probe.frameDeltaS < best.frameDeltaS ? probe : best),
    null
  );
  const longest = informative.reduce<SpacingProbe | null>(
    (best, probe) => (best === null || probe.frameDeltaS > best.frameDeltaS ? probe : best),
    null
  );
  const grewWithSpacing =
    shortest === null ||
    longest === null ||
    longest === shortest ||
    // Half of proportional growth or better: the travel rose with the time
    // rather than staying put, which is the whole distinction being drawn.
    longest.medianDisplacementPx >=
      0.5 * shortest.medianDisplacementPx * (longest.frameDeltaS / shortest.frameDeltaS);
  // Reaching further out also has to be somewhere worth reaching. When the
  // rungs past the informative one have already fallen under the correlation
  // floor, the ladder has shown that the surface stops looking like itself at
  // those spacings: "found nothing" there is the pattern dying, not the water
  // standing still, and the real run finds nothing too.
  //
  // A field ladder made the difference concrete. Its only rung with enough
  // usable vectors sat at 0.060 s and read 0.66 px — sub-pixel, so by
  // displacement alone the water looked too slow to see. Every longer rung
  // came back at 0.19-0.25 correlation against a floor of 0.35, and with no
  // second informative rung to compare against, the growth test had nothing
  // to weigh and waved the reach through. The run went to 0.960 s on a
  // channel independently timed at 0.83 m/s, where the water crosses fifty
  // pixels between frames, and returned no vectors at all.
  const reach = scored.reduce((best, probe) =>
    probe.frameDeltaS > best.frameDeltaS ? probe : best
  );
  const reachStillCorrelates = reach.medianCorrelation >= SSIV_THRESHOLDS.minCorrelation;
  const measuredTooSlow =
    longest !== null &&
    longest.medianDisplacementPx < 1 &&
    grewWithSpacing &&
    reachStillCorrelates;
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
