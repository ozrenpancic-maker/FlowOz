import { median, medianAbsoluteDeviation } from '../domain/linalg';
import { err, ok, type Result } from '../domain/result';
import type { NormalizedPoint } from '../domain/types';
import { ALGORITHM_VERSION } from '../domain/types';
import { buildCalibration, metricDisplacement, type Homography } from './homography';
import { extractPatch, findPeak, prepareGrid, type Grid } from './ncc';
import { ssivFailure, type SsivFailure } from './failure-taxonomy';
import { stabiliseAll } from './stabilisation';
import {
  SSIV_THRESHOLDS,
  type FramePair,
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
  shiftXPx: number,
  shiftYPx: number
): RawVector[] {
  const firstRaw: Grid = { data: pair.first, width: pair.width, height: pair.height };
  const secondRaw: Grid = { data: pair.second, width: pair.width, height: pair.height };
  // Integral images are built once per frame and reused by every interrogation
  // point, which is what keeps a six-pair analysis inside a field-usable time.
  const first = prepareGrid(firstRaw);
  const second = prepareGrid(secondRaw);
  const window = SSIV_THRESHOLDS.interrogationWindowPx;
  const radius = SSIV_THRESHOLDS.searchRadiusPx;
  // The reverse match only has to confirm a displacement we already know, so it
  // searches a tight neighbourhood rather than the full window.
  const reverseRadius = 3;
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

    // Camera drift is removed before anything else looks at the displacement.
    const dxPx = peak.subDx - shiftXPx;
    const dyPx = peak.subDy - shiftYPx;

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

/** Per-vector filters that need no knowledge of the other vectors. */
function applyPointFilters(vector: RawVector): VectorRejectionReason | null {
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
 * the other survivors in the same frame pair. Real surface flow is locally
 * coherent; a spurious match is not.
 */
function computeSpatialCoherence(vector: RawVector, neighbours: readonly RawVector[]): number {
  const others = neighbours.filter((candidate) => candidate !== vector);
  if (others.length === 0) return 0;

  const centreDx = median(others.map((candidate) => candidate.dxPx));
  const centreDy = median(others.map((candidate) => candidate.dyPx));
  const centreMagnitude = Math.hypot(centreDx, centreDy);
  if (!Number.isFinite(centreMagnitude)) return 0;

  const difference = Math.hypot(vector.dxPx - centreDx, vector.dyPx - centreDy);
  const scale = Math.max(centreMagnitude, 1); // one pixel floor, avoids /0
  const coherence = 1 - difference / scale;
  return Number.isFinite(coherence) ? Math.min(1, Math.max(0, coherence)) : 0;
}

function angleDifference(a: number, b: number): number {
  let difference = a - b;
  while (difference > Math.PI) difference -= 2 * Math.PI;
  while (difference < -Math.PI) difference += 2 * Math.PI;
  return Math.abs(difference);
}

export function analyse(input: SsivAnalysisInput): Result<SsivAnalysis, SsivFailure> {
  const { clip, roi, knownDimensions } = input;

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

  const stabilisation = stabiliseAll(clip.pairs, roi);
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

  const allVectors: RawVector[] = [];
  for (const pair of clip.pairs) {
    const entry = stabilisation.find((item) => item.pairIndex === pair.index);
    if (!entry || !entry.stable) continue; // unstable pairs contribute nothing
    if (
      pair.frameDeltaS < SSIV_THRESHOLDS.minFrameDeltaS ||
      pair.frameDeltaS > SSIV_THRESHOLDS.maxFrameDeltaS
    ) {
      continue; // outside the usable spacing; the decoder should not emit these
    }
    allVectors.push(...measurePair(pair, roi, entry.shiftXPx, entry.shiftYPx));
  }

  if (allVectors.length === 0) {
    return err(
      ssivFailure('VIDEO_DECODE_FAILURE', 'no interrogation point could be evaluated', {
        stablePairs: stablePairs.length,
        totalPairs: clip.pairs.length,
      })
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
  const anyTexture = allVectors.some(
    (vector) =>
      Number.isFinite(vector.correlation) && vector.correlation >= SSIV_THRESHOLDS.minCorrelation
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

  // Stage 3 — robust centre. The median is the centre; the MAD sets the band.
  let accepted: RawVector[] = [];
  if (coherent.length > 0) {
    const angles = coherent.map((vector) => vector.anglRad);
    const magnitudes = coherent.map((vector) => vector.magnitudePx);
    const centreAngle = median(angles);
    const centreMagnitude = median(magnitudes);
    const magnitudeMad = medianAbsoluteDeviation(magnitudes, centreMagnitude);
    const magnitudeBand = Number.isFinite(magnitudeMad) && magnitudeMad > 1e-6 ? 3 * magnitudeMad : 1;

    for (const vector of coherent) {
      // Surface flow is unidirectional over a short clip; a vector pointing
      // somewhere else is a mismatch, not a measurement.
      if (angleDifference(vector.anglRad, centreAngle) > Math.PI / 4) {
        vector.accepted = false;
        vector.rejectionReason = 'DIRECTIONAL_OUTLIER';
        continue;
      }
      if (Math.abs(vector.magnitudePx - centreMagnitude) > magnitudeBand) {
        vector.accepted = false;
        vector.rejectionReason = 'SPATIAL_OUTLIER';
        continue;
      }
      vector.accepted = true;
      accepted.push(vector);
    }
  }

  // Stage 4 — metric conversion through the homography, per vector.
  const velocities: number[] = [];
  const stillAccepted: RawVector[] = [];
  for (const vector of accepted) {
    const pair = clip.pairs.find((candidate) => candidate.index === vector.pairIndex);
    if (!pair) continue;
    const metric = metricDisplacement(homography, vector.x, vector.y, vector.dxPx, vector.dyPx);
    if (!metric || !Number.isFinite(metric.distanceM) || pair.frameDeltaS <= 0) {
      vector.accepted = false;
      vector.rejectionReason = 'NON_FINITE';
      continue;
    }
    vector.displacementM = metric.distanceM;
    vector.velocityMs = metric.distanceM / pair.frameDeltaS;
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
  };

  if (accepted.length < SSIV_THRESHOLDS.minAcceptedVectors) {
    return err(
      ssivFailure(
        'INSUFFICIENT_VALID_VECTORS',
        `${accepted.length}/${vectors.length} vectors passed every filter, ` +
          `${SSIV_THRESHOLDS.minAcceptedVectors} required`,
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

  const surfaceVelocity = median(velocities);
  if (!Number.isFinite(surfaceVelocity) || surfaceVelocity <= 0) {
    return err(
      ssivFailure('INSUFFICIENT_VALID_VECTORS', `median velocity ${surfaceVelocity}`, {
        totalVectors: vectors.length,
        acceptedVectors: accepted.length,
      })
    );
  }

  const frameDeltas = clip.pairs.map((pair) => pair.frameDeltaS);

  return ok({
    surfaceVelocity,
    velocitySpreadMs: medianAbsoluteDeviation(velocities, surfaceVelocity),
    calibrationStatus: homography.status,
    frameWidth: clip.width,
    frameHeight: clip.height,
    sourceWidth: clip.sourceWidth,
    sourceHeight: clip.sourceHeight,
    sampledPairs: clip.pairs.length,
    frameDeltaS: median(frameDeltas),
    stabilisation,
    vectors,
    quality,
    thresholds: SSIV_THRESHOLDS,
    algorithmVersion: ALGORITHM_VERSION,
    analysedAt: new Date().toISOString(),
  });
}
