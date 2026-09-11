/**
 * Image-quality metrics computed directly from the decoded SSIV frames.
 *
 * There is no ambient-light sensor input here by design (specification for
 * this feature explicitly rules it out): a phone's ambient sensor measures
 * light falling on the *phone*, not the *water surface* the lens is pointed
 * at, so it would be a worse proxy for "is this footage usable" than simply
 * reading the pixels the pipeline is about to correlate. Every metric below
 * is computed from the actual luminance plane, 0–255 per pixel, that
 * `video/decoder-html.ts` already produces (ITU-R BT.601 luma).
 */

export interface ImageQualityMetrics {
  /** Mean pixel luminance, 0–255. */
  meanLuminance: number;
  /** Fraction of pixels below the dark threshold, 0–1. */
  darkPixelFraction: number;
  /** Fraction of pixels above the saturation threshold, 0–1. */
  saturatedPixelFraction: number;
  /**
   * Median of each block's own standard deviation, 0–255-ish — a proxy for
   * how much trackable texture the surface actually carries. This is the same
   * quantity ZNCC correlation ultimately depends on, computed directly rather
   * than inferred from a correlation failure after the fact.
   */
  localContrast: number;
  /**
   * Variance of the discrete Laplacian response (Pech-Pacheco et al., 2000,
   * "Diatom autofocusing in brightfield microscopy: a comparative study").
   * Higher is sharper; a blurred image has a near-flat Laplacian response and
   * a low variance. Not normalised — compare against BLUR_SCORE_* thresholds.
   */
  blurScore: number;
  /**
   * Fraction of pixels that are both very bright and locally flat — a
   * specular highlight looks like a bright, textureless patch, unlike
   * genuinely bright but still-rippled sunlit water.
   */
  glareScore: number;
  sampleWidth: number;
  sampleHeight: number;
}

export const IMAGE_QUALITY_THRESHOLDS = Object.freeze({
  /** Pixels at or below this are "dark" [0-255]. */
  darkPixelLevel: 25,
  /** Pixels at or above this are "saturated" [0-255]. */
  saturatedPixelLevel: 250,
  /** Side length of the block grid used for localContrast/glareScore [px]. */
  blockSizePx: 8,
  /** A block at or above this mean is bright enough to be part of a glare patch. */
  glareBlockMeanLevel: 235,
  /** A block at or below this std-dev is flat enough to be part of a glare patch. */
  glareBlockStdDev: 6,

  // Hard-refusal floors/ceilings, checked once before any correlation runs.
  /** Below this mean luminance the clip is refused as underexposed. */
  underexposedMeanLuminance: 25,
  /** Above this dark-pixel fraction the clip is refused as underexposed. */
  underexposedDarkFraction: 0.85,
  /** Above this glare fraction the clip is refused outright. */
  excessiveGlareFraction: 0.35,
  /** Below this Laplacian variance the clip is refused as too blurred to track. */
  motionBlurFloor: 4,
  /** Below this local contrast the clip is refused: no trackable texture at all. */
  insufficientContrastFloor: 1.5,

  // Advisory bands for the DATA QUALITY breakdown (Phase 14) — softer than the
  // hard refusal floors above, so a clip that passed the refusal check can
  // still be graded ACCEPTABLE or POOR rather than only GOOD/refused.
  exposureGoodDarkFraction: 0.15,
  exposureAcceptableDarkFraction: 0.4,
  contrastGoodLevel: 6,
  contrastAcceptableLevel: 3,
  sharpnessGoodScore: 20,
  sharpnessAcceptableScore: 8,
  glareLowFraction: 0.05,
  glareModerateFraction: 0.15,
} as const);

function toArray(frame: Float32Array | number[]): { at: (i: number) => number; length: number } {
  return { at: (i: number) => frame[i] as number, length: frame.length };
}

/**
 * Compute every image-quality metric from one decoded luminance frame.
 * Pure and synchronous — the frame is already in memory as part of the
 * normal SSIV decode, so this adds no additional I/O or native calls.
 */
export function computeImageQuality(
  frame: Float32Array | number[],
  width: number,
  height: number
): ImageQualityMetrics {
  const pixels = toArray(frame);
  const n = width * height;

  let sum = 0;
  let dark = 0;
  let saturated = 0;
  for (let i = 0; i < n; i += 1) {
    const value = pixels.at(i);
    sum += value;
    if (value <= IMAGE_QUALITY_THRESHOLDS.darkPixelLevel) dark += 1;
    if (value >= IMAGE_QUALITY_THRESHOLDS.saturatedPixelLevel) saturated += 1;
  }
  const meanLuminance = n > 0 ? sum / n : 0;

  const { localContrast, glareScore } = computeBlockStats(pixels, width, height);
  const blurScore = computeLaplacianVariance(pixels, width, height);

  return {
    meanLuminance,
    darkPixelFraction: n > 0 ? dark / n : 0,
    saturatedPixelFraction: n > 0 ? saturated / n : 0,
    localContrast,
    blurScore,
    glareScore,
    sampleWidth: width,
    sampleHeight: height,
  };
}

function computeBlockStats(
  pixels: { at: (i: number) => number; length: number },
  width: number,
  height: number
): { localContrast: number; glareScore: number } {
  const block = IMAGE_QUALITY_THRESHOLDS.blockSizePx;
  const stdDevs: number[] = [];
  let glarePixels = 0;
  let totalPixels = 0;

  for (let by = 0; by < height; by += block) {
    const y1 = Math.min(height, by + block);
    for (let bx = 0; bx < width; bx += block) {
      const x1 = Math.min(width, bx + block);
      let count = 0;
      let blockSum = 0;
      for (let y = by; y < y1; y += 1) {
        const rowOffset = y * width;
        for (let x = bx; x < x1; x += 1) {
          blockSum += pixels.at(rowOffset + x);
          count += 1;
        }
      }
      if (count === 0) continue;
      const mean = blockSum / count;
      let variance = 0;
      for (let y = by; y < y1; y += 1) {
        const rowOffset = y * width;
        for (let x = bx; x < x1; x += 1) {
          const d = pixels.at(rowOffset + x) - mean;
          variance += d * d;
        }
      }
      variance /= count;
      const stdDev = Math.sqrt(variance);
      stdDevs.push(stdDev);

      if (
        mean >= IMAGE_QUALITY_THRESHOLDS.glareBlockMeanLevel &&
        stdDev <= IMAGE_QUALITY_THRESHOLDS.glareBlockStdDev
      ) {
        glarePixels += count;
      }
      totalPixels += count;
    }
  }

  stdDevs.sort((a, b) => a - b);
  const mid = Math.floor(stdDevs.length / 2);
  const localContrast =
    stdDevs.length === 0
      ? 0
      : stdDevs.length % 2 === 0
        ? ((stdDevs[mid - 1] as number) + (stdDevs[mid] as number)) / 2
        : (stdDevs[mid] as number);

  return {
    localContrast,
    glareScore: totalPixels > 0 ? glarePixels / totalPixels : 0,
  };
}

/** Variance of a discrete Laplacian, evaluated on interior pixels only. */
function computeLaplacianVariance(
  pixels: { at: (i: number) => number; length: number },
  width: number,
  height: number
): number {
  if (width < 3 || height < 3) return 0;
  const responses: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    const rowUp = row - width;
    const rowDown = row + width;
    for (let x = 1; x < width - 1; x += 1) {
      const laplacian =
        -4 * pixels.at(row + x) +
        pixels.at(row + x - 1) +
        pixels.at(row + x + 1) +
        pixels.at(rowUp + x) +
        pixels.at(rowDown + x);
      responses.push(laplacian);
    }
  }
  if (responses.length === 0) return 0;
  const mean = responses.reduce((a, b) => a + b, 0) / responses.length;
  const variance = responses.reduce((a, b) => a + (b - mean) * (b - mean), 0) / responses.length;
  return variance;
}

/**
 * Crop a rectangular region from a full frame — used to restrict the quality
 * metrics to the ROI's own bounding box rather than the whole frame, since a
 * textured bank alongside a genuinely glassy stretch of water would otherwise
 * mask exactly the problem these metrics exist to catch.
 */
export function cropFrame(
  frame: Float32Array | number[],
  frameWidth: number,
  frameHeight: number,
  region: { x0: number; y0: number; x1: number; y1: number }
): { data: Float32Array; width: number; height: number } {
  const x0 = Math.max(0, Math.floor(region.x0));
  const y0 = Math.max(0, Math.floor(region.y0));
  const x1 = Math.min(frameWidth, Math.ceil(region.x1));
  const y1 = Math.min(frameHeight, Math.ceil(region.y1));
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const srcRow = (y + y0) * frameWidth;
    const dstRow = y * width;
    for (let x = 0; x < width; x += 1) {
      data[dstRow + x] = frame[srcRow + x + x0] as number;
    }
  }
  return { data, width, height };
}

export type ImageQualityRefusalCode =
  | 'UNDEREXPOSED_VIDEO'
  | 'EXCESSIVE_GLARE'
  | 'INSUFFICIENT_SURFACE_CONTRAST'
  | 'MOTION_BLUR_TOO_HIGH';

/**
 * Hard refusal check, meant to run once on the first decoded frame before any
 * correlation is attempted — cheap, and gives a specific, actionable reason
 * instead of letting obviously unusable footage run the full SSIV pipeline
 * only to fail later with the generic INSUFFICIENT_TEXTURE / INSUFFICIENT_
 * VALID_VECTORS codes. A clip that passes this check can still fail at the
 * correlation stage for reasons this frame-statistics check cannot see
 * (uniform but non-repeating texture that still won't correlate, camera
 * shake, etc.) — the two checks are complementary, not duplicates.
 */
export function refuseOnImageQuality(metrics: ImageQualityMetrics): ImageQualityRefusalCode | null {
  const t = IMAGE_QUALITY_THRESHOLDS;
  if (metrics.meanLuminance < t.underexposedMeanLuminance || metrics.darkPixelFraction > t.underexposedDarkFraction) {
    return 'UNDEREXPOSED_VIDEO';
  }
  if (metrics.glareScore > t.excessiveGlareFraction) {
    return 'EXCESSIVE_GLARE';
  }
  // Contrast is checked before blur: a perfectly sharp photo of glass-flat
  // water also has ~zero Laplacian variance, because there are no edges to
  // respond to, not because anything is out of focus. Checking contrast
  // first means MOTION_BLUR_TOO_HIGH only fires when real texture is present
  // (proving the surface itself isn't the problem) but its fine edges are
  // smeared — the actual signature of camera/motion blur.
  if (metrics.localContrast < t.insufficientContrastFloor) {
    return 'INSUFFICIENT_SURFACE_CONTRAST';
  }
  if (metrics.blurScore < t.motionBlurFloor) {
    return 'MOTION_BLUR_TOO_HIGH';
  }
  return null;
}

export type QualityBand = 'GOOD' | 'ACCEPTABLE' | 'POOR';
export type GlareBand = 'LOW' | 'MODERATE' | 'HIGH';

/** Graded bands for the DATA QUALITY breakdown — softer than refuseOnImageQuality's hard floors. */
export function gradeExposure(metrics: ImageQualityMetrics): QualityBand {
  const t = IMAGE_QUALITY_THRESHOLDS;
  if (metrics.darkPixelFraction <= t.exposureGoodDarkFraction) return 'GOOD';
  if (metrics.darkPixelFraction <= t.exposureAcceptableDarkFraction) return 'ACCEPTABLE';
  return 'POOR';
}

export function gradeContrast(metrics: ImageQualityMetrics): QualityBand {
  const t = IMAGE_QUALITY_THRESHOLDS;
  if (metrics.localContrast >= t.contrastGoodLevel) return 'GOOD';
  if (metrics.localContrast >= t.contrastAcceptableLevel) return 'ACCEPTABLE';
  return 'POOR';
}

export function gradeSharpness(metrics: ImageQualityMetrics): QualityBand {
  const t = IMAGE_QUALITY_THRESHOLDS;
  if (metrics.blurScore >= t.sharpnessGoodScore) return 'GOOD';
  if (metrics.blurScore >= t.sharpnessAcceptableScore) return 'ACCEPTABLE';
  return 'POOR';
}

export function gradeGlare(metrics: ImageQualityMetrics): GlareBand {
  const t = IMAGE_QUALITY_THRESHOLDS;
  if (metrics.glareScore <= t.glareLowFraction) return 'LOW';
  if (metrics.glareScore <= t.glareModerateFraction) return 'MODERATE';
  return 'HIGH';
}
