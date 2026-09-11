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

/**
 * Zero-normalised correlation of a whole frame against the background — how
 * much of what this frame shows is the part that never moved.
 */
export function backgroundCorrelation(
  frame: ArrayLike<number>,
  background: Float32Array
): number {
  const count = background.length;
  if (frame.length !== count || count === 0) return NaN;

  let frameMean = 0;
  let backgroundMean = 0;
  for (let i = 0; i < count; i += 1) {
    frameMean += (frame[i] as number) / count;
    backgroundMean += (background[i] as number) / count;
  }

  let cross = 0;
  let frameVariance = 0;
  let backgroundVariance = 0;
  for (let i = 0; i < count; i += 1) {
    const a = (frame[i] as number) - frameMean;
    const b = (background[i] as number) - backgroundMean;
    cross += a * b;
    frameVariance += a * a;
    backgroundVariance += b * b;
  }

  const denominator = Math.sqrt(frameVariance * backgroundVariance);
  if (!(denominator > 1e-9)) return NaN;
  const correlation = cross / denominator;
  return Number.isFinite(correlation) ? correlation : NaN;
}

export interface BackgroundSuppression {
  /** The pairs to interrogate: background-subtracted when `applied`. */
  pairs: FramePair[];
  /**
   * Median correlation between the sampled frames and the estimated static
   * background — how much of this footage is scenery rather than water. NaN
   * when there were too few frames to estimate one at all.
   */
  correlation: number;
  applied: boolean;
}

/**
 * Remove whatever held still across the clip from every frame, so the water
 * interrogation sees only what moved.
 *
 * The subtraction is applied only when the frames genuinely share that static
 * content — measured, not assumed, against the same correlation floor the rest
 * of the pipeline already trusts a match at (`SSIV_THRESHOLDS.minCorrelation`).
 * Below it the estimate is not describing this scene, and subtracting it would
 * inject its own negation into every frame as a fresh common pattern, so the
 * frames are returned untouched.
 */
export function suppressStaticBackground(pairs: readonly FramePair[]): BackgroundSuppression {
  const reference = pairs[0];
  if (!reference) return { pairs: [...pairs], correlation: NaN, applied: false };

  const pixelCount = reference.width * reference.height;
  const sameSize = pairs.every(
    (pair) => pair.width === reference.width && pair.height === reference.height
  );
  if (!sameSize) return { pairs: [...pairs], correlation: NaN, applied: false };

  const frames: ArrayLike<number>[] = [];
  for (const pair of pairs) frames.push(pair.first, pair.second);

  const background = staticBackground(frames, pixelCount);
  if (!background) return { pairs: [...pairs], correlation: NaN, applied: false };

  const correlations = frames
    .map((frame) => backgroundCorrelation(frame, background))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (correlations.length === 0) {
    return { pairs: [...pairs], correlation: NaN, applied: false };
  }
  const middle = correlations.length >> 1;
  const correlation =
    correlations.length % 2 === 0
      ? ((correlations[middle - 1] as number) + (correlations[middle] as number)) / 2
      : (correlations[middle] as number);

  if (!(correlation >= SSIV_THRESHOLDS.minCorrelation)) {
    return { pairs: [...pairs], correlation, applied: false };
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
    correlation,
    applied: true,
  };
}
