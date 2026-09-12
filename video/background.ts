import { SSIV_THRESHOLDS, type FramePair } from './types';

/**
 * Temporal background suppression.
 *
 * On shallow, clear water the streambed shows through the surface, and the bed
 * is far better textured than the ripples travelling over it. Correlation then
 * locks onto the bed — a strong match at zero displacement — and reports a
 * surface velocity near zero while rejecting the real, weaker moving pattern
 * as LOW_CORRELATION. Confirmed on field footage: a cluster of interrogation
 * points scoring 0.63–0.80 correlation at displacements under 0.05 px, on a
 * channel independently measured at ~0.4 m/s, where the expected displacement
 * was ~4 px.
 *
 * The per-pixel median across every sampled frame is what the camera saw that
 * did not move. Subtracting it leaves only what changed — the surface pattern
 * the measurement is actually after. Anything genuinely static (bed, bank,
 * a rock the ROI overlaps) contributes nothing to the correlation afterwards.
 *
 * This is NOT the spatial high-pass filter ssiv-core's own comment records as
 * removed. That one leaked static background ACROSS a bank/water edge into the
 * window beside it and created exactly the phantom zero-displacement signal
 * this removes; a temporal median cannot leak spatially, because each pixel is
 * only ever compared with itself at other times.
 *
 * Subtracting a background the frames do not actually share would inject the
 * negated estimate into every frame as a new common pattern — the same phantom
 * by another route. So the estimate has to earn it: {@link suppressStaticBackground}
 * measures how well the background describes the frames and leaves them alone
 * unless it does. A camera that drifted fails that check the same way, which is
 * what keeps an unaligned median from inventing motion.
 */

/**
 * Frames needed before a per-pixel median describes "what stays still" rather
 * than blending a couple of samples of moving water.
 */
export const MIN_BACKGROUND_FRAMES = 6;

/** Per-pixel median across the frames: the part of the scene that holds still. */
export function staticBackground(
  frames: readonly ArrayLike<number>[],
  pixelCount: number
): Float32Array | null {
  if (frames.length < MIN_BACKGROUND_FRAMES || pixelCount <= 0) return null;
  if (frames.some((frame) => frame.length !== pixelCount)) return null;

  const background = new Float32Array(pixelCount);
  const samples = new Float64Array(frames.length);
  const middle = frames.length >> 1;
  const even = frames.length % 2 === 0;

  for (let i = 0; i < pixelCount; i += 1) {
    for (let f = 0; f < frames.length; f += 1) {
      samples[f] = (frames[f] as ArrayLike<number>)[i] as number;
    }
    samples.sort();
    background[i] = even
      ? ((samples[middle - 1] as number) + (samples[middle] as number)) / 2
      : (samples[middle] as number);
  }
  return background;
}

/** Pixel bounding box of a region of the frame. */
export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Zero-normalised correlation of a frame against the background over one
 * region — how much of what this frame shows there is the part that never
 * moved. `inside: false` measures everything OUTSIDE the box instead.
 *
 * Measured per region rather than over the whole frame on purpose. A whole-
 * frame number mixes two different questions: how much of the frame happens
 * to be scenery, and whether the estimate is trustworthy. A shot that is half
 * water reads about half on that scale no matter how solid the estimate is,
 * which says nothing about either question.
 */
export function backgroundCorrelation(
  frame: ArrayLike<number>,
  background: ArrayLike<number>,
  width: number,
  region?: Region,
  inside = true
): number {
  const count = background.length;
  if (frame.length !== count || count === 0 || width <= 0) return NaN;
  const height = count / width;

  const covers = (x: number, y: number) =>
    !region || (x >= region.x0 && x < region.x1 && y >= region.y0 && y < region.y1);

  let samples = 0;
  let frameMean = 0;
  let backgroundMean = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (covers(x, y) !== inside) continue;
      const i = y * width + x;
      frameMean += frame[i] as number;
      backgroundMean += background[i] as number;
      samples += 1;
    }
  }
  if (samples === 0) return NaN;
  frameMean /= samples;
  backgroundMean /= samples;

  let cross = 0;
  let frameVariance = 0;
  let backgroundVariance = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (covers(x, y) !== inside) continue;
      const i = y * width + x;
      const a = (frame[i] as number) - frameMean;
      const b = (background[i] as number) - backgroundMean;
      cross += a * b;
      frameVariance += a * a;
      backgroundVariance += b * b;
    }
  }

  const denominator = Math.sqrt(frameVariance * backgroundVariance);
  if (!(denominator > 1e-9)) return NaN;
  const correlation = cross / denominator;
  return Number.isFinite(correlation) ? correlation : NaN;
}

/**
 * How much two frames taken at different times still have in common over a
 * region — the same zero-normalised correlation, with neither frame having
 * contributed to the other. Frames from different pairs are seconds apart, so
 * whatever matches between them is the part of the scene that held still.
 */
export function framePairCorrelation(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  region?: Region,
  inside = true
): number {
  return backgroundCorrelation(a, b, width, region, inside);
}

function medianOf(values: number[]): number {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (usable.length === 0) return NaN;
  const middle = usable.length >> 1;
  return usable.length % 2 === 0
    ? ((usable[middle - 1] as number) + (usable[middle] as number)) / 2
    : (usable[middle] as number);
}

export interface BackgroundSuppression {
  /** The pairs to interrogate: background-subtracted when `applied`. */
  pairs: FramePair[];
  /**
   * Median correlation between the frames and the background INSIDE the ROI:
   * whether there is something static under this water at all — a streambed
   * showing through, or a bank the ROI overlaps. This is what decides the
   * subtraction, because it is the only place the correlation ever reads.
   */
  roiCorrelation: number;
  /**
   * The same measured OUTSIDE the ROI, over the scenery: whether the camera
   * held still. Diagnostic — a low value here with a high one inside the ROI
   * would mean the estimate is smeared and worth distrusting.
   */
  sceneCorrelation: number;
  applied: boolean;
}

/**
 * Remove whatever held still across the clip from every frame, so the water
 * interrogation sees only what moved.
 *
 * The subtraction is applied only when the frames genuinely share static
 * content where it matters — inside the ROI, measured, not assumed, against
 * the same correlation floor the rest of the pipeline already trusts a match
 * at (`SSIV_THRESHOLDS.minCorrelation`). Below it there is nothing static
 * under this water to take away, and subtracting the estimate anyway would
 * inject its own negation into every frame as a fresh common pattern, so the
 * frames are returned untouched.
 */
export function suppressStaticBackground(
  pairs: readonly FramePair[],
  roiRegion?: Region
): BackgroundSuppression {
  const unchanged = (roiCorrelation = NaN, sceneCorrelation = NaN): BackgroundSuppression => ({
    pairs: [...pairs],
    roiCorrelation,
    sceneCorrelation,
    applied: false,
  });

  const reference = pairs[0];
  if (!reference) return unchanged();

  const pixelCount = reference.width * reference.height;
  const sameSize = pairs.every(
    (pair) => pair.width === reference.width && pair.height === reference.height
  );
  if (!sameSize) return unchanged();

  const frames: ArrayLike<number>[] = [];
  for (const pair of pairs) frames.push(pair.first, pair.second);

  const background = staticBackground(frames, pixelCount);
  if (!background) return unchanged();

  // Judged by what frames taken SECONDS apart still have in common, not by
  // each frame against the median. A median built from these same frames
  // contains every one of them, so a frame correlates with it even when the
  // scene shares nothing — self-inclusion alone reads as a half-decent score
  // and would wave through an estimate worth nothing. Two frames from
  // different pairs share no moving water at all, so whatever still matches
  // between them is the part that held still.
  const acrossPairs: [ArrayLike<number>, ArrayLike<number>][] = [];
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    acrossPairs.push([(pairs[i] as FramePair).first, (pairs[i + 1] as FramePair).first]);
  }

  const width = reference.width;
  const persistence = (inside: boolean) =>
    medianOf(acrossPairs.map(([a, b]) => framePairCorrelation(a, b, width, roiRegion, inside)));

  const roiCorrelation = persistence(true);
  const sceneCorrelation = roiRegion ? persistence(false) : NaN;

  if (!(roiCorrelation >= SSIV_THRESHOLDS.minCorrelation)) {
    return unchanged(roiCorrelation, sceneCorrelation);
  }

  const subtract = (frame: ArrayLike<number>): Float32Array => {
    const out = new Float32Array(pixelCount);
    for (let i = 0; i < pixelCount; i += 1) {
      out[i] = (frame[i] as number) - (background[i] as number);
    }
    return out;
  };

  return {
    pairs: pairs.map((pair) => ({
      ...pair,
      first: subtract(pair.first),
      second: subtract(pair.second),
    })),
    roiCorrelation,
    sceneCorrelation,
    applied: true,
  };
}
