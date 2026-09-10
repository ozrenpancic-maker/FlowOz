import type { KnownRoiDimensions, WaterRoi } from '../domain/types';

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
  /** Smallest usable ROI, as a fraction of the frame area. */
  minRoiAreaFraction: 0.02,
  /** Interrogation window and search radius, in working-resolution pixels. */
  interrogationWindowPx: 24,
  searchRadiusPx: 12,
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
  /** Displacement mapped through the homography [m]. */
  displacementM?: number;
  /** Metric speed = displacementM / frameDeltaS [m/s]. */
  velocityMs?: number;
  accepted: boolean;
  rejectionReason?: VectorRejectionReason;
}

export interface FramePairStabilisation {
  pairIndex: number;
  /** Global camera displacement measured on the stationary part of the frame. */
  shiftXPx: number;
  shiftYPx: number;
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
}

export interface SsivAnalysis {
  /** Median metric surface velocity of the accepted vectors [m/s]. */
  surfaceVelocity: number;
  /** Robust spread of the accepted metric velocities (MAD) [m/s]. Diagnostic
   * only — this is not a validated uncertainty. */
  velocitySpreadMs: number;
  calibrationStatus: CalibrationStatus;
  frameWidth: number;
  frameHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  sampledPairs: number;
  frameDeltaS: number;
  stabilisation: FramePairStabilisation[];
  vectors: SsivVector[];
  quality: SsivQualitySummary;
  thresholds: typeof SSIV_THRESHOLDS;
  algorithmVersion: string;
  analysedAt: string;
}
