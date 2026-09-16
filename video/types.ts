import type { FlowDirection, KnownRoiDimensions, WaterRoi } from '../domain/types';
import type { ImageQualityMetrics } from './image-quality';

/**
 * Thresholds of the reference implementation (specification §11.5). They are
 * exported as one frozen object so the report, the UI and the tests all quote
 * the same numbers.
 */
export const SSIV_THRESHOLDS = Object.freeze({
  /**
   * Normalised cross-correlation floor for an interrogation point.
   *
   * Lowered from 0.55 after a controlled experiment, because 0.55 was
   * refusing data the pipeline could still measure. Field clip after field
   * clip came back with a median grid correlation between 0.37 and 0.49 and
   * almost every vector dropped as LOW_CORRELATION, on water whose
   * displacement was squarely inside the search range at the spacing the
   * pilot had chosen — so the floor, not the water, was the obstacle.
   *
   * What the raw correlation measures is how much of the pattern survived
   * from one frame to the next, not whether the peak found is the right one.
   * A surface that partly renews itself between frames — which is what fast,
   * broken water does — scores low at the true offset while the peak stays
   * exactly where it should be. The sweep in tests/video/correlation-floor
   * makes that concrete: a small window on coarse texture scored 0.56 at an
   * offset fourteen pixels wrong, while a larger one scored 0.26 and landed
   * within a third of a pixel.
   *
   * The value is measured rather than chosen. Running the whole pipeline over
   * synthetic clips whose surface renews by a known fraction, with the true
   * velocity known:
   *
   *   floor 0.20 — a clip with NO real motion at all reports 6.4 m/s
   *   floor 0.25 — that clip is refused; 70% renewal recovers to within 1%
   *   floor 0.35 — refused; 70% renewal recovers to within 7%
   *   floor 0.40 — refused; 70% renewal recovers to within 5%
   *   floor 0.45 — refused; 70% renewal now refused too
   *   floor 0.55 — refused; 70% renewal refused
   *
   * So pure noise starts getting through below 0.25 and recoverable data
   * starts being thrown away above 0.40. 0.35 is the middle of that band,
   * a tenth clear of either edge.
   *
   * Raising the interrogation window was the other candidate and was rejected
   * on the same evidence: 48 px cost 11% of the velocity on clean data and
   * 64 px cost 31%, because a window that large spans enough of the ROI to
   * average across the shear profile — and at 48 px with this floor a clip
   * with no motion in it reported 3.7 m/s.
   */
  minCorrelation: 0.35,
  /** Ratio between the best and the second-best correlation peak. */
  minPeakRatio: 1.015,
  /** Subpixel uncertainty ceiling [px]. */
  maxUncertaintyPx: 20,
  /** Forward/backward match disagreement ceiling [px]. */
  maxForwardBackwardPx: 1.5,
  /** Agreement of a vector with its neighbours, 0–1. */
  minSpatialCoherence: 0.25,
  /**
   * How far the reported velocity must stand clear of how much the frame
   * pairs disagree with each other, as a multiple of their median absolute
   * deviation.
   *
   * Between the PAIRS, deliberately, and not across the ROI. The spread
   * across the ROI is the channel's own velocity profile — slower at the
   * banks, faster mid-stream — which is real and is reported as such. Judging
   * a reading against it punishes exactly the well-behaved sheared flow it
   * should trust: a synthetic channel running 1.5 px at the banks and 4 in
   * the middle produced 160 of 160 vectors at correlation 1.00 and would have
   * been thrown out for a ratio of 1.5.
   *
   * Independent frame pairs, on the other hand, are looking at the same
   * water. Whether they agree says nothing about the profile and everything
   * about whether there is a flow there to agree on. Measured over synthetic
   * clips run through the whole pipeline against a known true velocity:
   *
   *   uniform flow                    ratio 271, velocity exact
   *   sheared profile                 ratio 468, velocity exact
   *   half the surface renewed        ratio 43,  velocity within 2%
   *   seven tenths renewed            ratio 24,  velocity within 7%
   *   eighty-five hundredths renewed  ratio 4.0, velocity 207% TOO HIGH
   *   surface replaced outright       ratio 1.8, velocity invented entirely
   *
   * Real flow sits at 24 and above, the two that lie at 4.0 and below. 6 is
   * inside that gap with half again the margin over the worse of the two, and
   * four times the headroom under the poorest reading still worth keeping.
   *
   * It closes a hole that predates the change: the 85%-renewed clip reported
   * four and a half metres per second against a true one and a half, from
   * five surviving vectors that happened to agree with each other, at every
   * correlation floor including the old one.
   */
  minPairAgreementRatio: 6,
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
   * Longest spacing the pilot ladder will probe [s].
   *
   * This is the ceiling of a search, not a claim about how long a water
   * surface stays recognisable: a spacing that has lost the pattern shows up
   * in the pilot as correlations under the floor and is discarded on that
   * evidence. What the ceiling does buy is reach at the slow end. On the
   * field geometry that failed — a 2 m reference length across a 240 px
   * working frame — one second of spacing puts the target displacement at
   * roughly 0.13 m/s, where the old 0.16 s cap could not resolve anything
   * under about 1.6 m/s without interpolating between two samples of the
   * correlation surface.
   */
  pilotMaxFrameDeltaS: 1.0,
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
  | 'UNRESOLVED_DISPLACEMENT'
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
  /**
   * Background anchors the frame geometry offered at all — grid positions
   * outside the ROI. Zero means the ROI left nowhere to measure the camera
   * from, which is a different operator problem from anchors that were there
   * and failed to track.
   */
  anchorsAvailable: number;
  /**
   * Anchors whose best match sat on the border of the search range, i.e. the
   * camera moved further between the two frames than the search could follow.
   * These are excluded from the fit. A high count is real camera motion, not
   * missing texture, and the two call for opposite corrections.
   */
  anchorsAtSearchEdge: number;
  /** Background anchors that tracked and were used in the fit. */
  anchorsUsed: number;
  /** Worst anchor residual against the fitted motion [px]. */
  residualPx: number;
  /**
   * Median correlation of the anchors the fit actually used — the quality of
   * the evidence the stabilisation rests on.
   */
  correlation: number;
  /**
   * Median correlation over every anchor that produced a peak, the ones below
   * the floor included. Diagnostic only: it says how much of the scenery
   * outside the ROI is worth tracking at all, which is a different question
   * from how good the anchors that were kept were, and must never gate the
   * pair — the weak ones have already been dropped by then.
   */
  candidateCorrelation: number;
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
   * Surface velocity that one pixel of displacement corresponds to in this
   * particular setup [m/s] — the ROI's own metric scale at its centre divided
   * by the frame spacing actually achieved. It is the quantum of the whole
   * measurement: nothing finer than this was measured, it was interpolated.
   *
   * It is reported because it is the number that decides whether a clip can
   * answer the question at all, and it is fixed before the first correlation
   * runs. Field evidence: a 2 m reference length across a 240 px working
   * frame at 0.16 s spacing puts one pixel at roughly a quarter of a metre
   * per second, so a channel genuinely running at 0.4 m/s moves about one
   * pixel between the two frames of a pair — far too little to locate a
   * correlation peak against, which is why that clip reported thousandths of
   * a metre per second instead of the real speed.
   */
  velocityResolutionMs: number;
  /**
   * Metres of real channel one working pixel covers, at the ROI's centre.
   * The scale everything else is derived from, and on its own the number that
   * says how much water a correlation window is looking at.
   */
  metresPerPixel: number;
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
  /** Reported metric surface velocity [m/s]. Never negative: see
   * `resolvedFlowDirection` for which way along the ROI it runs. */
  surfaceVelocity: number;
  /**
   * Which way along the ROI's own axis the water was found to be running,
   * taken from the measurement rather than from the operator's setting.
   *
   * The operator's setting is which way they expected it to run. When the
   * accepted vectors coherently disagree, they are the evidence and the
   * setting is not, so the measurement stands and this records the direction
   * it actually found. A reading that does not stand clear of its own scatter
   * determines nothing and is still refused — the sign is resolved, never
   * assumed away.
   */
  resolvedFlowDirection: FlowDirection;
  /** True when that direction is the opposite of the one set on the ROI. */
  flowDirectionDisagreedWithRoi: boolean;
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
