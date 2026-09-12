import type { FlowDirection, KnownRoiDimensions, WaterRoi } from '../domain/types';
import type { ImageQualityMetrics } from './image-quality';

/**
 * Thresholds of the reference implementation (specification §11.5). They are
 * exported as one frozen object so the report, the UI and the tests all quote
 * the same numbers.
 */
export const SSIV_THRESHOLDS = Object.freeze({
  /** Normalised cross-correlation floor for an interrogation point. */
  minCorrelation: 0.55,
  /** Ratio between the best and the second-best correlation peak. */
  minPeakRatio: 1.015,
  /** Subpixel uncertainty ceiling [px]. */
  maxUncertaintyPx: 20,
  /** Forward/backward match disagreement ceiling [px]. */
  maxForwardBackwardPx: 1.5,
  /** Agreement of a vector with its neighbours, 0–1. */
  minSpatialCoherence: 0.25,
  /** Vectors that must survive every filter before a velocity is reported. */
  minAcceptedVectors: 4,
  /** Ensemble grid nodes that must survive before the ensemble velocity is used. */
  minAcceptedEnsembleNodes: 4,
  /**
   * Pairs whose measured spacing sits within this fraction of the median
   * spacing are averaged together; a pair further off would blur the ensemble
   * peak, so it contributes to the per-pair vectors only.
   */
  ensembleDeltaBandFraction: 0.15,
  /** Correlation floor for the global camera-motion estimate. */
  minStabilisationCorrelation: 0.55,
  /** Stabilised pairs required out of `framePairs`. */
  minStablePairs: 3,
  /** Frame pairs sampled from the clip. */
  framePairs: 6,
  /** Interrogation grid inside the ROI: columns × rows. */
  gridColumns: 4,
  gridRows: 5,
  /** Working frame width; frames are downscaled to this, preserving aspect. */
  processingWidthPx: 240,
  /** Allowed spacing between the two frames of a pair [s]. */
  minFrameDeltaS: 0.06,
  maxFrameDeltaS: 0.16,
  /**
   * How far the spacing the decoder achieved may drift from the one the plan
   * asked for before the pair is discarded. A seek lands on the nearest
   * decodable frame, so some drift is normal; past this the pair would put a
   * timing error straight into the velocity.
   */
  maxFrameDeltaDeviationFraction: 0.5,
  /** Smallest usable ROI, as a fraction of the frame area. */
  minRoiAreaFraction: 0.02,
  /** Interrogation window, in working-resolution pixels. */
  interrogationWindowPx: 24,
  /**
   * Search radius for the water interrogation grid, in working-resolution
   * pixels. Widened from 12 to 24 after field testing on a real flowing
   * channel: at 12px, the true displacement of anything faster than a slow
   * trickle landed outside the search window and was rejected
   * (SEARCH_WINDOW_EDGE) or scored a weak correlation, leaving only near-zero
   * noise vectors to survive — a systematic, large underestimate, not a
   * random one. 24px raises the fastest resolvable surface speed without
   * shrinking the frame-pair spacing (which would have traded away
   * sensitivity to slow flows instead).
   *
   * Deliberately NOT shared with the background-anchor stabilisation search
   * (see stabilisationSearchRadiusPx) — widening this one alone regressed
   * stabilisation on realistically-sized ROIs, because the anchor margin
   * (interrogationWindowPx/2 + radius) grows with it and eats the background
   * strip outside the ROI. Camera shake between two frames is a much smaller,
   * unrelated displacement than the water's own motion, so the two radii have
   * no reason to match.
   */
  searchRadiusPx: 24,
  /** Search radius for background-anchor camera-motion tracking, in
   * working-resolution pixels — see searchRadiusPx's doc comment for why this
   * is a separate, smaller value. Unchanged from the original tuning. */
  stabilisationSearchRadiusPx: 12,
  /**
   * crossFlowRatio past which the ROI's downstream edge is probably not
   * parallel to the actual flow — see SsivQualitySummary.crossFlowRatio.
   */
  crossFlowWarningRatio: 0.5,
} as const);

export type CalibrationStatus = 'VALID' | 'POOR' | 'INVALID';

/** Why a single interrogation vector was thrown away. */
export type VectorRejectionReason =
  | 'LOW_CORRELATION'
  | 'WEAK_PEAK_SEPARATION'
  | 'HIGH_UNCERTAINTY'
  | 'FORWARD_BACKWARD_MISMATCH'
  | 'SEARCH_WINDOW_EDGE'
  | 'DIRECTIONAL_OUTLIER'
  | 'SPATIAL_OUTLIER'
  | 'NON_FINITE';

/**
 * Full metadata contract for one interrogation point. Everything the filters
 * looked at is retained, accepted or not, so a saved measurement can be audited
 * later without re-running the analysis.
 */
export interface SsivVector {
  /** Frame pair index, 0-based. */
  pairIndex: number;
  /** Grid position inside the ROI. */
  gridColumn: number;
  gridRow: number;
  /** Interrogation centre in working-resolution pixels. */
  x: number;
  y: number;
  /** Raw displacement in working-resolution pixels, camera motion removed. */
  dxPx: number;
  dyPx: number;
  correlation: number;
  peakRatio: number;
  snr: number;
  uncertaintyPx: number;
  forwardBackwardPx: number;
  spatialCoherence: number;
  /** Total displacement mapped through the homography [m], diagnostic only. */
  displacementM?: number;
  /**
   * Signed velocity along the flow axis [m/s] — positive is downstream, the
   * direction the ROI's own edges define (edge 1-2 towards edge 4-3). This is
   * what discharge is built from: water crossing the measurement section is
   * what Q counts, and a vector's cross-stream component contributes nothing
   * to that regardless of how large it is.
   */
  velocityMs?: number;
  /** Signed cross-stream velocity [m/s], diagnostic only — see velocityMs. */
  lateralVelocityMs?: number;
  /** Total surface speed = displacementM / frameDeltaS [m/s], diagnostic only. */
  speedMs?: number;
  accepted: boolean;
  rejectionReason?: VectorRejectionReason;
}

/**
 * A similarity transform of the image plane: x' = a·x − b·y + tx,
 * y' = b·x + a·y + ty. Rotation and scale live in (a, b); a pure translation
 * is a = 1, b = 0.
 */
export interface SimilarityTransform {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * One interrogation node of the ensemble estimate: the correlation surfaces of
 * every usable frame pair averaged before the peak was looked for. Where the
 * per-pair vectors see one noisy match each, this sees the match the pairs
 * have in common.
 */
export interface EnsembleVector {
  gridColumn: number;
  gridRow: number;
  /** Interrogation centre in working-resolution pixels. */
  x: number;
  y: number;
  /** Displacement over the mean pair spacing, camera motion removed [px]. */
  dxPx: number;
  dyPx: number;
  correlation: number;
  peakRatio: number;
  snr: number;
  uncertaintyPx: number;
  forwardBackwardPx: number;
  /** Frame pairs whose surfaces were averaged at this node. */
  pairsUsed: number;
  /** Mean spacing of those pairs [s], the time the displacement covers. */
  frameDeltaS: number;
  /** Total displacement mapped through the homography [m], diagnostic only. */
  displacementM?: number;
  /** Signed velocity along the flow axis [m/s] — see SsivVector.velocityMs. */
  velocityMs?: number;
  /** Signed cross-stream velocity [m/s], diagnostic only. */
  lateralVelocityMs?: number;
  /** Total surface speed [m/s], diagnostic only. */
  speedMs?: number;
  accepted: boolean;
  rejectionReason?: VectorRejectionReason;
}

export interface FramePairStabilisation {
  pairIndex: number;
  /**
   * Camera displacement at the frame centre, measured on the stationary part
   * of the frame [px]. With a similarity model the displacement elsewhere in
   * the frame differs; use `cameraDisplacementAt` rather than these directly.
   */
  shiftXPx: number;
  shiftYPx: number;
  /** How the camera motion was modelled for this pair. */
  model: 'translation' | 'similarity';
  /** Present when the model is a similarity. */
  similarity?: SimilarityTransform;
  /** Rotation and scale implied by the similarity, for the record. */
  rotationRad?: number;
  scale?: number;
  /** Background anchors that tracked and were used in the fit. */
  anchorsUsed: number;
  /** Worst anchor residual against the fitted motion [px]. */
  residualPx: number;
  correlation: number;
  stable: boolean;
  frameDeltaS: number;
}

/** Two decoded, downscaled frames plus the time between them. */
export interface FramePair {
  index: number;
  /** Grayscale luminance, row-major, length = width · height. */
  first: Float32Array | number[];
  second: Float32Array | number[];
  width: number;
  height: number;
  /** Time between the two frames [s]. */
  frameDeltaS: number;
}

export interface DecodedClip {
  /** Native frame size, before downscaling. */
  sourceWidth: number;
  sourceHeight: number;
  /** Working frame size actually analysed. */
  width: number;
  height: number;
  durationS: number;
  pairs: FramePair[];
}

export interface SsivAnalysisInput {
  clip: DecodedClip;
  roi: WaterRoi;
  knownDimensions: KnownRoiDimensions;
  /** Defaults to FORWARD when omitted. */
  flowDirection?: FlowDirection;
}

export interface SsivQualitySummary {
  totalVectors: number;
  acceptedVectors: number;
  rejectedVectors: number;
  /** accepted / total, 0–1. */
  acceptanceRatio: number;
  rejectionsByReason: Record<VectorRejectionReason, number>;
  stablePairs: number;
  totalPairs: number;
  medianCorrelation: number;
  /** Median absolute camera displacement across stabilised pairs [px]. */
  cameraCompensationPx: number;
  /** Ensemble nodes evaluated and accepted, and pairs that fed the ensemble. */
  ensembleNodes: number;
  acceptedEnsembleNodes: number;
  ensemblePairsUsed: number;
  /**
   * Median |lateral| / median |streamwise| over the accepted vectors that
   * fed the reported velocity. A high ratio means the water is genuinely
   * moving across the section as much as along it, or — far more likely in
   * practice — the ROI's downstream edge was not drawn parallel to the
   * actual flow, so a real streamwise speed is mixed with a spurious
   * "sideways" reading that a magnitude-based velocity would have hidden.
   */
  crossFlowRatio: number;
  /** crossFlowRatio past which the operator is warned the ROI may be misaligned. */
  crossFlowWarningRatio: number;
  /**
   * Distinct interrogation-grid columns (out of SSIV_THRESHOLDS.gridColumns)
   * represented among the vectors that fed the reported velocity. Confirmed
   * on real field data: when this is 1, every accepted vector came from the
   * same strip of the ROI while the rest of the grid was rejected outright —
   * the classic signature of an ROI edge sitting on the bank or a rock
   * instead of moving water, which a high crossFlowRatio alone reads as a
   * misaligned edge rather than what it actually is.
   */
  distinctAcceptedColumns: number;
  /**
   * Median correlation between the sampled frames and the static background
   * estimated from them, measured INSIDE the ROI: whether there is anything
   * static under this water at all — a streambed showing through, or a bank
   * the ROI overlaps. This is what decides the suppression, because it is the
   * only place the correlation ever reads. NaN when there were too few frames
   * to estimate a background.
   */
  staticBackgroundCorrelation: number;
  /**
   * The same measured OUTSIDE the ROI, over the scenery — whether the camera
   * held still. Diagnostic only: a low value here says the estimate is
   * smeared by camera drift and worth distrusting even where it reads high.
   */
  sceneBackgroundCorrelation: number;
  /** Whether that background was actually subtracted before interrogation. */
  backgroundSuppressed: boolean;
  /** Image-quality metrics computed on the ROI's own bounding box of the first
   * decoded frame — present whenever a clip has at least one frame pair. */
  imageQuality?: ImageQualityMetrics;
}

export interface SsivAnalysis {
  /** Reported metric surface velocity [m/s]. */
  surfaceVelocity: number;
  /**
   * Where the reported velocity came from: the ensemble estimate when enough
   * of its nodes survived, otherwise the median of the per-pair vectors.
   */
  velocitySource: 'ensemble' | 'instantaneous';
  /** Median of the accepted per-pair vector velocities [m/s], when any. */
  instantaneousVelocity?: number;
  /** Median of the accepted ensemble node velocities [m/s], when any. */
  ensembleVelocity?: number;
  /**
   * Signed median cross-stream velocity [m/s], diagnostic only — from the
   * same accepted vector/ensemble set that fed surfaceVelocity. Never used to
   * compute discharge; see SsivQualitySummary.crossFlowRatio.
   */
  lateralVelocity?: number;
  /** Median total surface speed (√(streamwise²+lateral²)) [m/s], diagnostic
   * only — never used to compute discharge. */
  speedMagnitude?: number;
  /** Robust spread of the accepted per-pair velocities (MAD) [m/s]. Diagnostic
   * only — this is not a validated uncertainty. */
  velocitySpreadMs: number;
  /** Robust spread of the accepted ensemble node velocities across the ROI [m/s]. */
  ensembleSpreadMs?: number;
  calibrationStatus: CalibrationStatus;
  frameWidth: number;
  frameHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  sampledPairs: number;
  frameDeltaS: number;
  stabilisation: FramePairStabilisation[];
  vectors: SsivVector[];
  ensemble: EnsembleVector[];
  quality: SsivQualitySummary;
  thresholds: typeof SSIV_THRESHOLDS;
  algorithmVersion: string;
  analysedAt: string;
}
