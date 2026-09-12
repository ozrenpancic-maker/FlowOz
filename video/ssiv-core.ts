import { median, medianAbsoluteDeviation } from '../domain/linalg';
import { err, ok, type Result } from '../domain/result';
import type { NormalizedPoint, WaterRoi } from '../domain/types';
import { ALGORITHM_VERSION } from '../domain/types';
import { buildCalibration, metricDisplacement, type Homography } from './homography';
import {
  extractPatch,
  findPeak,
  peakOfSurface,
  prepareGrid,
  rawCorrelationSurface,
  type Grid,
  type PreparedGrid,
} from './ncc';
import { suppressStaticBackground } from './background';
import { applyClahe } from './clahe';
import { ssivFailure, type SsivFailure } from './failure-taxonomy';
import { cameraDisplacementAt, stabiliseAll } from './stabilisation';
import { computeImageQuality, cropFrame, refuseOnImageQuality, type ImageQualityMetrics } from './image-quality';
import { roiPolygon, toPixels } from './roi';
import {
  SSIV_THRESHOLDS,
  type EnsembleVector,
  type FramePair,
  type FramePairStabilisation,
  type SsivAnalysis,
  type SsivAnalysisInput,
  type SsivQualitySummary,
  type SsivVector,
  type VectorRejectionReason,
} from './types';

/**
 * Surface-velocity estimation by cross-correlation (SSIV).
 *
 * Experimental, and labelled as such everywhere it surfaces: this is not a
 * validated LSPIV implementation. The pipeline is deterministic and every
 * rejected vector keeps its metrics, so a saved run can be audited afterwards.
 */

const EMPTY_REJECTIONS: Record<VectorRejectionReason, number> = {
  LOW_CORRELATION: 0,
  WEAK_PEAK_SEPARATION: 0,
  HIGH_UNCERTAINTY: 0,
  FORWARD_BACKWARD_MISMATCH: 0,
  SEARCH_WINDOW_EDGE: 0,
  DIRECTIONAL_OUTLIER: 0,
  SPATIAL_OUTLIER: 0,
  NON_FINITE: 0,
};

function bilinear(a: NormalizedPoint, b: NormalizedPoint, t: number): NormalizedPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Axis-aligned pixel bounding box of the ROI polygon, clamped to the frame. */
function roiPixelBoundingBox(
  roi: WaterRoi,
  frameWidth: number,
  frameHeight: number
): { x0: number; y0: number; x1: number; y1: number } {
  const pixels = roiPolygon(roi).map((point) => toPixels(point, frameWidth, frameHeight));
  const xs = pixels.map((p) => p.x);
  const ys = pixels.map((p) => p.y);
  return {
    x0: Math.max(0, Math.min(...xs)),
    y0: Math.max(0, Math.min(...ys)),
    x1: Math.min(frameWidth, Math.max(...xs)),
    y1: Math.min(frameHeight, Math.max(...ys)),
  };
}

/** Interrogation grid inside the ROI quadrilateral, in normalised coordinates. */
export function interrogationGrid(
  roi: SsivAnalysisInput['roi'],
  columns = SSIV_THRESHOLDS.gridColumns,
  rows = SSIV_THRESHOLDS.gridRows
): { column: number; row: number; point: NormalizedPoint }[] {
  const points: { column: number; row: number; point: NormalizedPoint }[] = [];
  for (let row = 0; row < rows; row += 1) {
    const v = (row + 0.5) / rows;
    const left = bilinear(roi.topLeft, roi.bottomLeft, v);
    const right = bilinear(roi.topRight, roi.bottomRight, v);
    for (let column = 0; column < columns; column += 1) {
      const u = (column + 0.5) / columns;
      points.push({ column, row, point: bilinear(left, right, u) });
    }
  }
  return points;
}

interface RawVector extends SsivVector {
  /** Kept internally so coherence can be evaluated per frame pair. */
  magnitudePx: number;
  anglRad: number;
}

function measurePair(
  pair: FramePair,
  roi: SsivAnalysisInput['roi'],
  motion: FramePairStabilisation
): RawVector[] {
  const firstRaw: Grid = { data: pair.first, width: pair.width, height: pair.height };
  const secondRaw: Grid = { data: pair.second, width: pair.width, height: pair.height };
  // Integral images are built once per frame and reused by every interrogation
  // point, which is what keeps a six-pair analysis inside a field-usable time.
  const first = prepareGrid(firstRaw);
  const second = prepareGrid(secondRaw);
  const window = SSIV_THRESHOLDS.interrogationWindowPx;
  const radius = SSIV_THRESHOLDS.searchRadiusPx;
  // The reverse search is centred where the forward match landed, so a
  // consistent round-trip returns to the origin: reverse ≈ −forward. That
  // expected offset can be as large as the forward displacement itself, so
  // the reverse search needs the same radius as the forward one — a smaller
  // fixed radius here would silently cap how much displacement the
  // forward-backward check could ever confirm, rejecting any real
  // displacement past that cap as FORWARD_BACKWARD_MISMATCH regardless of
  // how consistent the two directions actually were.
  const reverseRadius = radius;
  const vectors: RawVector[] = [];

  for (const node of interrogationGrid(roi)) {
    const x = node.point.x * pair.width;
    const y = node.point.y * pair.height;

    const base: RawVector = {
      pairIndex: pair.index,
      gridColumn: node.column,
      gridRow: node.row,
      x,
      y,
      dxPx: NaN,
      dyPx: NaN,
      correlation: 0,
      peakRatio: 0,
      snr: 0,
      uncertaintyPx: Number.POSITIVE_INFINITY,
      forwardBackwardPx: Number.POSITIVE_INFINITY,
      spatialCoherence: 0,
      accepted: false,
      rejectionReason: 'NON_FINITE',
      magnitudePx: NaN,
      anglRad: NaN,
    };

    const patch = extractPatch(firstRaw, x, y, window);
    if (!patch) {
      // A flat or out-of-frame interrogation point: no texture to track.
      vectors.push({ ...base, rejectionReason: 'LOW_CORRELATION' });
      continue;
    }

    const peak = findPeak(patch, second, x, y, radius);
    if (!peak) {
      vectors.push({ ...base, rejectionReason: 'NON_FINITE' });
      continue;
    }

    // Reverse match: track the matched window in frame 2 back into frame 1.
    // A real displacement is consistent in both directions.
    let forwardBackwardPx = Number.POSITIVE_INFINITY;
    const reversePatch = extractPatch(secondRaw, x + peak.dx, y + peak.dy, window);
    if (reversePatch) {
      const reversePeak = findPeak(reversePatch, first, x + peak.dx, y + peak.dy, reverseRadius);
      if (reversePeak) {
        forwardBackwardPx = Math.hypot(
          peak.subDx + reversePeak.subDx,
          peak.subDy + reversePeak.subDy
        );
      }
    }

    // Camera motion is removed before anything else looks at the displacement.
    // With a similarity model it differs across the frame, so it is evaluated
    // at this point rather than taken as one global shift.
    const camera = cameraDisplacementAt(motion, x, y);
    const dxPx = peak.subDx - camera.dx;
    const dyPx = peak.subDy - camera.dy;

    vectors.push({
      ...base,
      dxPx,
      dyPx,
      correlation: peak.correlation,
      peakRatio: peak.peakRatio,
      snr: peak.snr,
      uncertaintyPx: peak.uncertaintyPx,
      forwardBackwardPx,
      spatialCoherence: 0,
      magnitudePx: Math.hypot(dxPx, dyPx),
      anglRad: Math.atan2(dyPx, dxPx),
      accepted: false,
      ...(peak.atSearchEdge ? { rejectionReason: 'SEARCH_WINDOW_EDGE' as const } : {}),
    });
  }

  return vectors;
}

/** What the per-point filters look at, common to per-pair and ensemble vectors. */
interface PointMetrics {
  dxPx: number;
  dyPx: number;
  correlation: number;
  peakRatio: number;
  uncertaintyPx: number;
  forwardBackwardPx: number;
  rejectionReason?: VectorRejectionReason;
}

/** Per-vector filters that need no knowledge of the other vectors. */
function applyPointFilters(vector: PointMetrics): VectorRejectionReason | null {
  if (vector.rejectionReason === 'SEARCH_WINDOW_EDGE') return 'SEARCH_WINDOW_EDGE';
  if (![vector.dxPx, vector.dyPx].every(Number.isFinite)) return 'NON_FINITE';
  if (!Number.isFinite(vector.correlation) || vector.correlation < SSIV_THRESHOLDS.minCorrelation) {
    return 'LOW_CORRELATION';
  }
  if (vector.peakRatio < SSIV_THRESHOLDS.minPeakRatio) return 'WEAK_PEAK_SEPARATION';
  if (vector.uncertaintyPx > SSIV_THRESHOLDS.maxUncertaintyPx) return 'HIGH_UNCERTAINTY';
  if (vector.forwardBackwardPx > SSIV_THRESHOLDS.maxForwardBackwardPx) {
    return 'FORWARD_BACKWARD_MISMATCH';
  }
  return null;
}

/**
 * Spatial coherence of a vector: how well it agrees with the robust centre of
 * its own immediate grid neighbours (up to a 3×3 block sharing a column or
 * row within 1 cell) — not the whole pair's vector set. A channel's true
 * velocity profile is locally smooth but globally varied (slower at the
 * banks, faster at the centre); comparing against a *global* median would
 * read a real, valid shear region as noise merely for differing from the
 * centreline. Comparing against local neighbours only flags a vector that
 * disagrees with the water immediately around it, which is what an actual
 * mismatch or spurious correlation looks like.
 */
function computeSpatialCoherence(vector: RawVector, sameFramePair: readonly RawVector[]): number {
  const neighbours = sameFramePair.filter(
    (candidate) =>
      candidate !== vector &&
      Math.abs(candidate.gridColumn - vector.gridColumn) <= 1 &&
      Math.abs(candidate.gridRow - vector.gridRow) <= 1
  );
  if (neighbours.length === 0) return 0;

  const centreDx = median(neighbours.map((candidate) => candidate.dxPx));
  const centreDy = median(neighbours.map((candidate) => candidate.dyPx));
  const centreMagnitude = Math.hypot(centreDx, centreDy);
  if (!Number.isFinite(centreMagnitude)) return 0;

  const difference = Math.hypot(vector.dxPx - centreDx, vector.dyPx - centreDy);
  const scale = Math.max(centreMagnitude, 1); // one pixel floor, avoids /0
  const coherence = 1 - difference / scale;
  return Number.isFinite(coherence) ? Math.min(1, Math.max(0, coherence)) : 0;
}

/**
 * Robust direction of a set of displacements [rad].
 *
 * The median of the angles themselves is wrong at the ±π branch cut: flow
 * running leftward across the frame gives angles just under +π and just over
 * −π, whose median is 0 — the exact opposite direction, which would then reject
 * every vector as a directional outlier. Taking the median per component and
 * forming the angle from those has no wrap to get wrong.
 */
export function robustDirection(dx: readonly number[], dy: readonly number[]): number {
  if (dx.length === 0 || dx.length !== dy.length) return NaN;
  return Math.atan2(median(dy), median(dx));
}

function angleDifference(a: number, b: number): number {
  let difference = a - b;
  while (difference > Math.PI) difference -= 2 * Math.PI;
  while (difference < -Math.PI) difference += 2 * Math.PI;
  return Math.abs(difference);
}

/**
 * Ensemble correlation (Meinhart, Wereley & Santiago 2000; Meselhe et al.
 * 2004): the raw numerator and denominator terms of every usable pair's
 * correlation surface are summed at each candidate offset — not the finished,
 * already-normalised correlation values — and only then is one ratio taken
 * and a peak looked for (see rawCorrelationAt for why the raw terms and not
 * the ratios). The water's true displacement contributes the same signal in
 * every pair and so accumulates in step with the pair count; a spurious match
 * lands somewhere different in each pair and does not.
 *
 * What this buys is reliability, not a higher correlation ceiling: the
 * expected correlation at the true offset is set by the surface's own
 * signal-to-noise ratio and does not rise just because more pairs were
 * averaged (confirmed empirically — the median correlation here holds flat
 * from 6 pairs to 400). What shrinks with more pairs is the *spread* around
 * that expected value, which is what stops a single unlucky pair's noise
 * from outvoting the true peak, or a single lucky one from being mistaken for
 * a strong match it is not. A texture with no signal-to-noise ratio worth
 * having stays refused either way — this is not a route around
 * INSUFFICIENT_TEXTURE, it is a steadier reading of what texture there is.
 *
 * Camera motion differs per pair, so each pair's surface is centred on the
 * node displaced by that pair's integer camera shift; the fractional parts
 * are averaged and removed afterwards. Only pairs whose measured spacing sits
 * close to the median spacing take part — the displacement being averaged has
 * to mean the same thing in every pair.
 */
function measureEnsemble(
  pairs: readonly FramePair[],
  stabilisation: readonly FramePairStabilisation[],
  roi: SsivAnalysisInput['roi']
): { vectors: EnsembleVector[]; pairsUsed: number; frameDeltaS: number } {
  const usable = pairs.filter((pair) => {
    const entry = stabilisation.find((item) => item.pairIndex === pair.index);
    return entry?.stable === true;
  });
  if (usable.length === 0) return { vectors: [], pairsUsed: 0, frameDeltaS: NaN };

  const medianDelta = median(usable.map((pair) => pair.frameDeltaS));
  const band = SSIV_THRESHOLDS.ensembleDeltaBandFraction;
  const members = usable.filter(
    (pair) => Math.abs(pair.frameDeltaS - medianDelta) <= band * medianDelta
  );
  if (members.length === 0) return { vectors: [], pairsUsed: 0, frameDeltaS: NaN };
  const frameDeltaS =
    members.reduce((total, pair) => total + pair.frameDeltaS, 0) / members.length;

  const window = SSIV_THRESHOLDS.interrogationWindowPx;
  const radius = SSIV_THRESHOLDS.searchRadiusPx;
  // Same reasoning as measurePair's reverseRadius: the expected reverse
  // offset (−forward) can be as large as the forward displacement itself.
  const reverseRadius = radius;
  const span = 2 * radius + 1;
  const reverseSpan = 2 * reverseRadius + 1;

  const prepared = members.map((pair) => ({
    pair,
    motion: stabilisation.find((item) => item.pairIndex === pair.index) as FramePairStabilisation,
    firstRaw: { data: pair.first, width: pair.width, height: pair.height } as Grid,
    secondRaw: { data: pair.second, width: pair.width, height: pair.height } as Grid,
    first: null as PreparedGrid | null,
    second: null as PreparedGrid | null,
  }));
  for (const entry of prepared) {
    entry.first = prepareGrid(entry.firstRaw);
    entry.second = prepareGrid(entry.secondRaw);
  }

  const first = members[0] as FramePair;
  const vectors: EnsembleVector[] = [];

  for (const node of interrogationGrid(roi)) {
    const x = node.point.x * first.width;
    const y = node.point.y * first.height;

    const base: EnsembleVector = {
      gridColumn: node.column,
      gridRow: node.row,
      x,
      y,
      dxPx: NaN,
      dyPx: NaN,
      correlation: 0,
      peakRatio: 0,
      snr: 0,
      uncertaintyPx: Number.POSITIVE_INFINITY,
      forwardBackwardPx: Number.POSITIVE_INFINITY,
      pairsUsed: 0,
      frameDeltaS,
      accepted: false,
      rejectionReason: 'NON_FINITE',
    };

    // Forward: sum the raw cross-product and window-variance terms of every
    // pair's surface at this node — not their finished ratios (see
    // rawCorrelationAt) — then normalise once at the end.
    const sumCross = new Float64Array(span * span);
    const sumVariance = new Float64Array(span * span);
    let sumPatchNormSq = 0;
    let pairsUsed = 0;
    let fractionX = 0;
    let fractionY = 0;
    const centres: { entry: (typeof prepared)[number]; cx: number; cy: number }[] = [];

    for (const entry of prepared) {
      const patch = extractPatch(entry.firstRaw, x, y, window);
      if (!patch || !entry.second) continue;
      const camera = cameraDisplacementAt(entry.motion, x, y);
      const cx = x + Math.round(camera.dx);
      const cy = y + Math.round(camera.dy);
      const raw = rawCorrelationSurface(patch, entry.second, cx, cy, radius);
      let any = false;
      for (let i = 0; i < raw.cross.length; i += 1) {
        const variance = raw.windowVarianceSum[i] as number;
        if (!Number.isFinite(variance)) continue;
        sumCross[i] = (sumCross[i] as number) + (raw.cross[i] as number);
        sumVariance[i] = (sumVariance[i] as number) + variance;
        any = true;
      }
      if (!any) continue;
      sumPatchNormSq += patch.norm * patch.norm;
      pairsUsed += 1;
      fractionX += camera.dx - Math.round(camera.dx);
      fractionY += camera.dy - Math.round(camera.dy);
      centres.push({ entry, cx, cy });
    }

    if (pairsUsed === 0) {
      vectors.push({ ...base, rejectionReason: 'LOW_CORRELATION' });
      continue;
    }

    const ensembleSurface = new Float32Array(sumCross.length);
    for (let i = 0; i < ensembleSurface.length; i += 1) {
      const denominator = Math.sqrt(sumPatchNormSq * (sumVariance[i] as number));
      ensembleSurface[i] = denominator > 1e-9 ? (sumCross[i] as number) / denominator : NaN;
    }
    const peak = peakOfSurface(ensembleSurface, radius);
    if (!peak) {
      vectors.push({ ...base, pairsUsed, rejectionReason: 'NON_FINITE' });
      continue;
    }

    // Reverse: the matched window of every second frame tracked back into its
    // first frame, accumulated the same raw way, must land where it started.
    const reverseSumCross = new Float64Array(reverseSpan * reverseSpan);
    const reverseSumVariance = new Float64Array(reverseSpan * reverseSpan);
    let reversePatchNormSq = 0;
    for (const { entry, cx, cy } of centres) {
      if (!entry.first) continue;
      const reversePatch = extractPatch(entry.secondRaw, cx + peak.dx, cy + peak.dy, window);
      if (!reversePatch) continue;
      const raw = rawCorrelationSurface(reversePatch, entry.first, cx + peak.dx, cy + peak.dy, reverseRadius);
      let any = false;
      for (let i = 0; i < raw.cross.length; i += 1) {
        const variance = raw.windowVarianceSum[i] as number;
        if (!Number.isFinite(variance)) continue;
        reverseSumCross[i] = (reverseSumCross[i] as number) + (raw.cross[i] as number);
        reverseSumVariance[i] = (reverseSumVariance[i] as number) + variance;
        any = true;
      }
      if (any) reversePatchNormSq += reversePatch.norm * reversePatch.norm;
    }
    const reverseSurface = new Float32Array(reverseSumCross.length);
    for (let i = 0; i < reverseSurface.length; i += 1) {
      const denominator = Math.sqrt(reversePatchNormSq * (reverseSumVariance[i] as number));
      reverseSurface[i] = denominator > 1e-9 ? (reverseSumCross[i] as number) / denominator : NaN;
    }
    const reversePeak = peakOfSurface(reverseSurface, reverseRadius);
    // The reverse surface is centred where the forward peak landed, so a
    // consistent match returns to the node: reverse ≈ −forward.
    const forwardBackwardPx = reversePeak
      ? Math.hypot(peak.subDx + reversePeak.subDx, peak.subDy + reversePeak.subDy)
      : Number.POSITIVE_INFINITY;

    const dxPx = peak.subDx - fractionX / pairsUsed;
    const dyPx = peak.subDy - fractionY / pairsUsed;

    vectors.push({
      ...base,
      dxPx,
      dyPx,
      correlation: peak.correlation,
      peakRatio: peak.peakRatio,
      snr: peak.snr,
      uncertaintyPx: peak.uncertaintyPx,
      forwardBackwardPx,
      pairsUsed,
      accepted: false,
      ...(peak.atSearchEdge ? { rejectionReason: 'SEARCH_WINDOW_EDGE' as const } : {}),
    });
  }

  return { vectors, pairsUsed: members.length, frameDeltaS };
}

/**
 * The gate every candidate set passes on its way to a velocity: a robust
 * direction and a robust magnitude band. Surface flow is unidirectional over
 * a short clip and its speed varies smoothly, so anything pointing elsewhere
 * or far off the median speed is a mismatch, not a measurement.
 */
function robustGate<T extends { dxPx: number; dyPx: number }>(
  candidates: readonly T[]
): { accepted: T[]; directional: T[]; magnitude: T[] } {
  const accepted: T[] = [];
  const directional: T[] = [];
  const magnitude: T[] = [];
  if (candidates.length === 0) return { accepted, directional, magnitude };

  const centreAngle = robustDirection(
    candidates.map((vector) => vector.dxPx),
    candidates.map((vector) => vector.dyPx)
  );
  const magnitudes = candidates.map((vector) => Math.hypot(vector.dxPx, vector.dyPx));
  const centreMagnitude = median(magnitudes);
  const magnitudeMad = medianAbsoluteDeviation(magnitudes, centreMagnitude);
  const magnitudeBand = Number.isFinite(magnitudeMad) && magnitudeMad > 1e-6 ? 3 * magnitudeMad : 1;

  for (const vector of candidates) {
    const angle = Math.atan2(vector.dyPx, vector.dxPx);
    if (angleDifference(angle, centreAngle) > Math.PI / 4) {
      directional.push(vector);
      continue;
    }
    if (Math.abs(Math.hypot(vector.dxPx, vector.dyPx) - centreMagnitude) > magnitudeBand) {
      magnitude.push(vector);
      continue;
    }
    accepted.push(vector);
  }
  return { accepted, directional, magnitude };
}

export function analyse(input: SsivAnalysisInput): Result<SsivAnalysis, SsivFailure> {
  const { clip, roi, knownDimensions } = input;
  const streamwiseSign = input.flowDirection === 'REVERSED' ? -1 : 1;

  if (clip.pairs.length === 0) {
    return err(ssivFailure('VIDEO_DECODE_FAILURE', 'no frame pairs were decoded'));
  }
  if (clip.pairs.some((pair) => pair.width <= 0 || pair.height <= 0)) {
    return err(ssivFailure('VIDEO_DECODE_FAILURE', 'a decoded frame has no dimensions'));
  }
  if (
    clip.pairs.some(
      (pair) =>
        pair.first.length !== pair.width * pair.height ||
        pair.second.length !== pair.width * pair.height
    )
  ) {
    return err(ssivFailure('VIDEO_DECODE_FAILURE', 'decoded frame size does not match its buffer'));
  }

  // Cheap frame-statistics gate, run once on the first frame, before any
  // correlation work: obviously unusable footage (too dark, blown-out glare,
  // no texture at all, too blurred to resolve) gets a specific, actionable
  // reason immediately instead of failing later with the generic
  // INSUFFICIENT_TEXTURE / INSUFFICIENT_VALID_VECTORS codes. Restricted to the
  // ROI's own bounding box: a textured bank elsewhere in frame must not mask a
  // genuinely glassy stretch of water, which is exactly the case this exists
  // to catch.
  let imageQuality: ImageQualityMetrics | undefined;
  const firstPair = clip.pairs[0];
  if (firstPair) {
    const box = roiPixelBoundingBox(roi, firstPair.width, firstPair.height);
    const region = cropFrame(firstPair.first, firstPair.width, firstPair.height, box);
    if (region.width > 0 && region.height > 0) {
      imageQuality = computeImageQuality(region.data, region.width, region.height);
      const refusal = refuseOnImageQuality(imageQuality);
      if (refusal) {
        return err(ssivFailure(refusal, undefined, { imageQuality }));
      }
    }
  }

  // Calibration comes first: without a VALID homography there is no metric
  // velocity to report, and the run stops before any correlation work.
  const calibration = buildCalibration(roi, knownDimensions, clip.width, clip.height);
  if (!calibration.ok) {
    return err(
      ssivFailure(
        'INVALID_ROI_CALIBRATION',
        calibration.error.detail ?? calibration.error.code,
        { calibrationStatus: 'INVALID' }
      )
    );
  }
  const homography: Homography = calibration.value;

  // ZNCC already removes each window's own mean and scales by its own
  // variance (see correlateAt), which is what a high-pass filter would try to
  // do for illumination gradients narrower than a window. A filter wide
  // enough to be safe for genuine ripple texture turned out to leak static
  // background through a sharp bank/water edge into an otherwise glassy,
  // untrackable surface and correlate it against itself at zero displacement
  // — a phantom flow signal on water that carries nothing. ZNCC's local
  // normalisation has no such cross-region leak, so no separate filtering
  // step runs here.
  const pairs = clip.pairs;

  // Camera motion is measured on the scenery, which is exactly the static
  // content the suppression below removes — so it runs first, and on planes
  // stretched for local contrast, which helps precisely where the anchors
  // look. The water grid gets no such per-frame mapping: being nonlinear and
  // recomputed per frame, it would keep the same scenery from mapping to the
  // same values twice and blunt the temporal background estimate.
  const stabilisationPairs = pairs.map((pair) => ({
    ...pair,
    first: applyClahe(pair.first as Float32Array, pair.width, pair.height),
    second: applyClahe(pair.second as Float32Array, pair.width, pair.height),
  }));
  const stabilisation = stabiliseAll(stabilisationPairs, roi);
  const stablePairs = stabilisation.filter((entry) => entry.stable);
  if (stablePairs.length < SSIV_THRESHOLDS.minStablePairs) {
    return err(
      ssivFailure(
        'UNSTABLE_CAMERA',
        `${stablePairs.length}/${clip.pairs.length} pairs stabilised, ` +
          `${SSIV_THRESHOLDS.minStablePairs} required`,
        { stablePairs: stablePairs.length, totalPairs: clip.pairs.length }
      )
    );
  }

  // The spacing the decoder achieved, not the one it aimed for. A seek lands on
  // the nearest decodable frame, so the achieved spacing is allowed to sit one
  // frame either side of the planned band — the velocity divides by the
  // measured value, and a displacement that has grown too large is caught by
  // the search-window edge test rather than by guessing here.
  const deltaTolerance = SSIV_THRESHOLDS.maxFrameDeltaDeviationFraction;
  const minUsableDeltaS = SSIV_THRESHOLDS.minFrameDeltaS * (1 - deltaTolerance);
  const maxUsableDeltaS = SSIV_THRESHOLDS.maxFrameDeltaS * (1 + deltaTolerance);

  // Everything that held still across the clip is removed before the water is
  // interrogated, so a streambed visible through shallow water cannot win the
  // correlation against the ripples moving over it — see background.ts. The
  // decision is measured inside the ROI, the only place the correlation
  // actually reads.
  const firstFrame = clip.pairs[0];
  const background = suppressStaticBackground(
    pairs,
    firstFrame ? roiPixelBoundingBox(roi, firstFrame.width, firstFrame.height) : undefined
  );
  const movingPairs = background.pairs;

  // The ensemble estimate: correlation surfaces of every stabilised pair
  // averaged before a peak is looked for, judged by the same filters as the
  // per-pair vectors and then the same robust gate, node by node. Computed
  // up front, alongside the per-pair pass, because a texture too weak for any
  // single pair is exactly what this is for — the INSUFFICIENT_TEXTURE gate
  // below has to see it before giving up.
  const ensembleRun = measureEnsemble(movingPairs, stabilisation, roi);
  const ensemble = ensembleRun.vectors;
  const ensembleVelocities: number[] = [];
  {
    const survivors: EnsembleVector[] = [];
    for (const node of ensemble) {
      const rejection = applyPointFilters(node);
      if (rejection) {
        node.accepted = false;
        node.rejectionReason = rejection;
      } else {
        delete node.rejectionReason;
        survivors.push(node);
      }
    }
    const gate = robustGate(survivors);
    for (const node of gate.directional) {
      node.accepted = false;
      node.rejectionReason = 'DIRECTIONAL_OUTLIER';
    }
    for (const node of gate.magnitude) {
      node.accepted = false;
      node.rejectionReason = 'SPATIAL_OUTLIER';
    }
    for (const node of gate.accepted) {
      const metric = metricDisplacement(homography, node.x, node.y, node.dxPx, node.dyPx);
      if (!metric || !Number.isFinite(metric.distanceM) || !(node.frameDeltaS > 0)) {
        node.accepted = false;
        node.rejectionReason = 'NON_FINITE';
        continue;
      }
      node.displacementM = metric.distanceM;
      node.velocityMs = (streamwiseSign * metric.dyM) / node.frameDeltaS;
      node.lateralVelocityMs = metric.dxM / node.frameDeltaS;
      node.speedMs = metric.distanceM / node.frameDeltaS;
      node.accepted = true;
      ensembleVelocities.push(node.velocityMs);
    }
  }
  const acceptedEnsemble = ensemble.filter((node) => node.accepted);

  const allVectors: RawVector[] = [];
  const mistimedPairs: number[] = [];
  for (const pair of movingPairs) {
    const entry = stabilisation.find((item) => item.pairIndex === pair.index);
    if (!entry || !entry.stable) continue; // unstable pairs contribute nothing
    if (pair.frameDeltaS < minUsableDeltaS || pair.frameDeltaS > maxUsableDeltaS) {
      mistimedPairs.push(pair.index);
      continue;
    }
    allVectors.push(...measurePair(pair, roi, entry));
  }

  if (allVectors.length === 0) {
    return err(
      ssivFailure(
        'VIDEO_DECODE_FAILURE',
        mistimedPairs.length > 0
          ? `no interrogation point could be evaluated; pairs ${mistimedPairs.join(', ')} ` +
            `were spaced outside ${minUsableDeltaS.toFixed(3)}–${maxUsableDeltaS.toFixed(3)} s`
          : 'no interrogation point could be evaluated',
        {
          stablePairs: stablePairs.length,
          totalPairs: clip.pairs.length,
        }
      )
    );
  }

  // Stage 1 — per-point filters.
  const survivors: RawVector[] = [];
  for (const vector of allVectors) {
    const rejection = applyPointFilters(vector);
    if (rejection) {
      vector.accepted = false;
      vector.rejectionReason = rejection;
    } else {
      delete vector.rejectionReason;
      survivors.push(vector);
    }
  }

  const correlations = allVectors
    .map((vector) => vector.correlation)
    .filter((value) => Number.isFinite(value));
  const medianCorrelation = correlations.length > 0 ? median(correlations) : 0;

  // No point anywhere reached the correlation floor: the water surface carried
  // nothing trackable.
  const anyTexture =
    allVectors.some(
      (vector) =>
        Number.isFinite(vector.correlation) && vector.correlation >= SSIV_THRESHOLDS.minCorrelation
    ) ||
    ensemble.some(
      (node) => Number.isFinite(node.correlation) && node.correlation >= SSIV_THRESHOLDS.minCorrelation
    );
  if (!anyTexture) {
    return err(
      ssivFailure('INSUFFICIENT_TEXTURE', `median correlation ${medianCorrelation.toFixed(3)}`, {
        totalVectors: allVectors.length,
        acceptedVectors: 0,
        medianCorrelation,
        stablePairs: stablePairs.length,
        totalPairs: clip.pairs.length,
      })
    );
  }

  // Stage 2 — spatial coherence, evaluated per frame pair among the survivors.
  const byPair = new Map<number, RawVector[]>();
  for (const vector of survivors) {
    const list = byPair.get(vector.pairIndex);
    if (list) list.push(vector);
    else byPair.set(vector.pairIndex, [vector]);
  }
  const coherent: RawVector[] = [];
  for (const group of byPair.values()) {
    for (const vector of group) {
      vector.spatialCoherence = computeSpatialCoherence(vector, group);
      if (vector.spatialCoherence < SSIV_THRESHOLDS.minSpatialCoherence) {
        vector.accepted = false;
        vector.rejectionReason = 'SPATIAL_OUTLIER';
      } else {
        coherent.push(vector);
      }
    }
  }

  // Stage 3 — robust direction and magnitude band over the coherent vectors.
  let accepted: RawVector[] = [];
  {
    const gate = robustGate(coherent);
    for (const vector of gate.directional) {
      vector.accepted = false;
      vector.rejectionReason = 'DIRECTIONAL_OUTLIER';
    }
    for (const vector of gate.magnitude) {
      vector.accepted = false;
      vector.rejectionReason = 'SPATIAL_OUTLIER';
    }
    for (const vector of gate.accepted) vector.accepted = true;
    accepted = gate.accepted;
  }

  // Stage 4 — metric conversion through the homography, per vector.
  const velocities: number[] = [];
  const stillAccepted: RawVector[] = [];
  for (const vector of accepted) {
    const pair = pairs.find((candidate) => candidate.index === vector.pairIndex);
    if (!pair) continue;
    const metric = metricDisplacement(homography, vector.x, vector.y, vector.dxPx, vector.dyPx);
    if (!metric || !Number.isFinite(metric.distanceM) || pair.frameDeltaS <= 0) {
      vector.accepted = false;
      vector.rejectionReason = 'NON_FINITE';
      continue;
    }
    vector.displacementM = metric.distanceM;
    vector.velocityMs = (streamwiseSign * metric.dyM) / pair.frameDeltaS;
    vector.lateralVelocityMs = metric.dxM / pair.frameDeltaS;
    vector.speedMs = metric.distanceM / pair.frameDeltaS;
    velocities.push(vector.velocityMs);
    stillAccepted.push(vector);
  }
  accepted = stillAccepted;

  const vectors: SsivVector[] = allVectors.map((vector) => {
    const { magnitudePx, anglRad, ...rest } = vector;
    void magnitudePx;
    void anglRad;
    return rest;
  });


  const rejectionsByReason = { ...EMPTY_REJECTIONS };
  for (const vector of vectors) {
    if (!vector.accepted && vector.rejectionReason) {
      rejectionsByReason[vector.rejectionReason] += 1;
    }
  }

  const ensembleUsable = acceptedEnsemble.length >= SSIV_THRESHOLDS.minAcceptedEnsembleNodes;
  const instantaneousUsable = accepted.length >= SSIV_THRESHOLDS.minAcceptedVectors;

  if (!ensembleUsable && !instantaneousUsable) {
    return err(
      ssivFailure(
        'INSUFFICIENT_VALID_VECTORS',
        `${accepted.length}/${vectors.length} vectors and ` +
          `${acceptedEnsemble.length}/${ensemble.length} ensemble nodes passed every filter, ` +
          `${SSIV_THRESHOLDS.minAcceptedVectors} vectors or ` +
          `${SSIV_THRESHOLDS.minAcceptedEnsembleNodes} nodes required` +
          (mistimedPairs.length > 0
            ? ` (${mistimedPairs.length} pair(s) dropped for frame spacing)`
            : ''),
        {
          totalVectors: vectors.length,
          acceptedVectors: accepted.length,
          medianCorrelation,
          stablePairs: stablePairs.length,
          totalPairs: clip.pairs.length,
          calibrationStatus: homography.status,
        }
      )
    );
  }

  // A metric velocity is reported only for a VALID calibration.
  if (homography.status !== 'VALID') {
    return err(
      ssivFailure('INVALID_ROI_CALIBRATION', `calibration status ${homography.status}`, {
        calibrationStatus: homography.status,
        acceptedVectors: accepted.length,
        totalVectors: vectors.length,
      })
    );
  }

  // The ensemble is the primary estimate: it is what the pairs agree on. The
  // per-pair median stands in when too few nodes survived, and is reported
  // alongside either way so the two can be compared.
  const instantaneousVelocity = velocities.length > 0 ? median(velocities) : undefined;
  const ensembleVelocity = ensembleVelocities.length > 0 ? median(ensembleVelocities) : undefined;
  const velocitySource: SsivAnalysis['velocitySource'] =
    ensembleUsable && ensembleVelocity !== undefined ? 'ensemble' : 'instantaneous';
  const surfaceVelocity =
    velocitySource === 'ensemble' ? (ensembleVelocity as number) : (instantaneousVelocity ?? NaN);

  // The scatter of the very vectors that produced the number above. Water
  // crossing the section purely sideways leaves a streamwise median that is
  // noise either side of zero, so a bare `<= 0` test is decided by which way
  // that noise happened to fall — half such clips would be reported as a real,
  // confidently tiny velocity. Requiring the reading to stand clear of its own
  // scatter is that same test made robust, and it invents nothing: the floor
  // is the spread this measurement actually produced. Vectors that all agree
  // exactly have no scatter and are not held back by it.
  const reportedSpread =
    velocitySource === 'ensemble'
      ? ensembleVelocities.length > 0
        ? medianAbsoluteDeviation(ensembleVelocities, ensembleVelocity)
        : 0
      : velocities.length > 0
        ? medianAbsoluteDeviation(velocities, instantaneousVelocity)
        : 0;
  const noiseFloor = Number.isFinite(reportedSpread) ? Math.max(0, reportedSpread) : 0;

  if (!Number.isFinite(surfaceVelocity) || surfaceVelocity <= 0 || surfaceVelocity <= noiseFloor) {
    // Distinct from the vector-count check above: enough vectors passed every
    // quality filter here, but they average out to zero, to upstream motion,
    // or to a number smaller than their own disagreement — a different real
    // cause (no net downstream flow, or the ROI's flow direction not matching
    // the actual flow) than "too few tracked points", so the detail says
    // exactly that instead of repeating "median velocity".
    return err(
      ssivFailure(
        'INSUFFICIENT_VALID_VECTORS',
        `${accepted.length}/${vectors.length} vectors passed every filter (at or above the ` +
          `${SSIV_THRESHOLDS.minAcceptedVectors}-vector minimum), but the median streamwise ` +
          `velocity was ${Number.isFinite(surfaceVelocity) ? surfaceVelocity.toFixed(6) : 'non-finite'} m/s ` +
          `against a spread of ${noiseFloor.toFixed(6)} m/s — ` +
          'no net downstream motion was measured',
        {
          totalVectors: vectors.length,
          acceptedVectors: accepted.length,
        }
      )
    );
  }

  const frameDeltas = clip.pairs.map((pair) => pair.frameDeltaS);

  // Cross-flow ratio is measured on whichever set actually fed
  // surfaceVelocity, so it reflects the reported number rather than the
  // other estimate that was passed over.
  const sourceForCrossFlow = velocitySource === 'ensemble' ? acceptedEnsemble : accepted;
  const streamwiseAbs = sourceForCrossFlow
    .map((entry) => Math.abs(entry.velocityMs ?? NaN))
    .filter((value) => Number.isFinite(value));
  const lateralAbs = sourceForCrossFlow
    .map((entry) => Math.abs(entry.lateralVelocityMs ?? NaN))
    .filter((value) => Number.isFinite(value));
  const medianStreamwiseAbs = streamwiseAbs.length > 0 ? median(streamwiseAbs) : 0;
  const medianLateralAbs = lateralAbs.length > 0 ? median(lateralAbs) : 0;
  const crossFlowRatio = medianStreamwiseAbs > 0 ? medianLateralAbs / medianStreamwiseAbs : 0;

  // How much of the ROI's width the reported velocity actually speaks for.
  // A high crossFlowRatio from vectors spread across the grid is a real
  // alignment problem; the same ratio from a single column is instead the
  // signature of that column sitting on the bank, not the water.
  const distinctAcceptedColumns = new Set(sourceForCrossFlow.map((entry) => entry.gridColumn)).size;

  // Signed diagnostics from the same set surfaceVelocity itself came from —
  // never used for discharge, only reported alongside it.
  const lateralSigned = sourceForCrossFlow
    .map((entry) => entry.lateralVelocityMs)
    .filter((value): value is number => Number.isFinite(value));
  const speedValues = sourceForCrossFlow
    .map((entry) => entry.speedMs)
    .filter((value): value is number => Number.isFinite(value));
  const lateralVelocity = lateralSigned.length > 0 ? median(lateralSigned) : undefined;
  const speedMagnitude = speedValues.length > 0 ? median(speedValues) : undefined;

  const quality: SsivQualitySummary = {
    totalVectors: vectors.length,
    acceptedVectors: accepted.length,
    rejectedVectors: vectors.length - accepted.length,
    acceptanceRatio: vectors.length > 0 ? accepted.length / vectors.length : 0,
    rejectionsByReason,
    stablePairs: stablePairs.length,
    totalPairs: clip.pairs.length,
    medianCorrelation,
    cameraCompensationPx: median(
      stablePairs.map((entry) => Math.hypot(entry.shiftXPx, entry.shiftYPx))
    ),
    ensembleNodes: ensemble.length,
    acceptedEnsembleNodes: acceptedEnsemble.length,
    ensemblePairsUsed: ensembleRun.pairsUsed,
    crossFlowRatio,
    crossFlowWarningRatio: SSIV_THRESHOLDS.crossFlowWarningRatio,
    distinctAcceptedColumns,
    staticBackgroundCorrelation: background.roiCorrelation,
    sceneBackgroundCorrelation: background.sceneCorrelation,
    backgroundSuppressed: background.applied,
    ...(imageQuality ? { imageQuality } : {}),
  };

  return ok({
    surfaceVelocity,
    velocitySource,
    ...(instantaneousVelocity !== undefined ? { instantaneousVelocity } : {}),
    ...(ensembleVelocity !== undefined ? { ensembleVelocity } : {}),
    ...(lateralVelocity !== undefined ? { lateralVelocity } : {}),
    ...(speedMagnitude !== undefined ? { speedMagnitude } : {}),
    velocitySpreadMs:
      velocities.length > 0
        ? medianAbsoluteDeviation(velocities, instantaneousVelocity)
        : Number.NaN,
    ...(ensembleVelocities.length > 0
      ? { ensembleSpreadMs: medianAbsoluteDeviation(ensembleVelocities, ensembleVelocity) }
      : {}),
    calibrationStatus: homography.status,
    frameWidth: clip.width,
    frameHeight: clip.height,
    sourceWidth: clip.sourceWidth,
    sourceHeight: clip.sourceHeight,
    sampledPairs: clip.pairs.length,
    frameDeltaS: median(frameDeltas),
    stabilisation,
    vectors,
    ensemble,
    quality,
    thresholds: SSIV_THRESHOLDS,
    algorithmVersion: ALGORITHM_VERSION,
    analysedAt: new Date().toISOString(),
  });
}
