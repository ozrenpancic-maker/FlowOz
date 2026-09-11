import type { LengthUnit, SlopeUnit } from './units';
import type { EllipseFit, Point2D } from './ellipse';
import type { CameraFingerprint, SensorSnapshot } from './sensor-snapshot';

export type { LengthUnit };

export type GeometryKind = 'circular' | 'rectangular' | 'trapezoidal';

/** Side-slope of a trapezoidal channel, expressed in one of three ways. */
export type SideSlopeInput =
  | { mode: 'ratio'; value: number } // horizontal run per unit rise (z)
  | { mode: 'angle'; degrees: number } // angle from the horizontal
  | { mode: 'wettedLength'; length: number }; // wetted side length for the current depth

export interface CircularDimensions {
  kind: 'circular';
  /** Internal diameter D, in metres. */
  diameter: number;
}

export interface RectangularDimensions {
  kind: 'rectangular';
  /** Channel width B, in metres. */
  width: number;
  /** Optional total structure height H, in metres. Not used by the hydraulics. */
  totalHeight?: number;
}

export interface TrapezoidalDimensions {
  kind: 'trapezoidal';
  /** Bottom width b, in metres. */
  bottomWidth: number;
  leftSlope: SideSlopeInput;
  rightSlope: SideSlopeInput;
}

export type Dimensions = CircularDimensions | RectangularDimensions | TrapezoidalDimensions;

/** Cross-section properties for a given depth. All values in SI units. */
export interface SectionProperties {
  /** Wetted area A [m²]. */
  area: number;
  /** Wetted perimeter P [m]. */
  wettedPerimeter: number;
  /** Top (free-surface) width T [m]. */
  topWidth: number;
  /** Hydraulic radius Rh = A / P [m]. */
  hydraulicRadius: number;
  /** Fill ratio h/D — circular sections only. */
  fillRatio?: number;
  /** Wetted central angle θ [rad] — circular sections only. */
  wettedAngle?: number;
}

/** Where a displayed value came from. Never merged with quality. */
export type Provenance =
  | 'SITE'
  | 'ENTERED'
  | 'MEASURED'
  | 'MEASURED_VIDEO'
  | 'ASSUMED'
  | 'CALIBRATED'
  | 'CALCULATED'
  | 'ESTIMATED';

/** Quality grade of one component or of the measurement as a whole. */
export type QualityGrade = 'A' | 'B' | 'C' | 'INVALID';

export type VelocityMethod = 'manning' | 'manual' | 'video';

export type LevelMethod = 'manual' | 'camera-assisted';

export type ProcessingStatus = 'CAPTURED' | 'PROCESSING' | 'PROCESSED' | 'INVALID';

export type VideoSource = 'camera' | 'import';

export type AlphaStatus = 'default' | 'calibrating' | 'calibrated';

export interface GeoLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  timestamp: number;
}

export interface GravityVector {
  x: number;
  y: number;
  z: number;
}

/** Normalised (0–1) image coordinate. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Four-point ROI quadrilateral in normalised image coordinates. Flow runs from
 * the top edge (points 1–2) towards the bottom edge (points 4–3), unless
 * FlowDirection says otherwise. */
export interface WaterRoi {
  topLeft: NormalizedPoint;
  topRight: NormalizedPoint;
  bottomRight: NormalizedPoint;
  bottomLeft: NormalizedPoint;
}

/**
 * Which ROI edge the water actually flows towards. FORWARD is the ROI's own
 * drawn convention (edge 1-2 towards edge 4-3); REVERSED flips the sign of
 * the streamwise component the SSIV pipeline reports, without touching the
 * ROI geometry or the metric calibration — for when the operator's ROI has
 * the near and far edges swapped relative to the true flow direction.
 * Absent on an older saved measurement means FORWARD, its implicit default.
 */
export type FlowDirection = 'FORWARD' | 'REVERSED';

/**
 * The one supported metric scale: physical ROI dimensions entered by the
 * operator. There is deliberately no pixel-scale fallback.
 */
export interface KnownRoiDimensions {
  /** Physical width across the flow, between the left and right ROI edges [m]. */
  widthM: number;
  /** Physical length along the flow, between the top and bottom ROI edges [m]. */
  lengthM: number;
}

/**
 * Full evidence behind a camera-assisted level reading — everything the
 * ellipse fit actually produced, plus the device pose at capture time. No
 * field here is ever a placeholder: an absent optional field means the value
 * was not available, never a guessed 0/NaN. Camera Level remains
 * EXPERIMENTAL (see EllipseFit's own doc comment) — this only records what
 * was measured, it does not upgrade the method's confidence.
 */
export interface CameraLevelEvidence {
  /** The photo's own pixel dimensions, not the preview box's. */
  sourceImageWidth?: number;
  sourceImageHeight?: number;
  /** Points the operator marked on the rim, in the photo's source pixels. */
  rimPoints: Point2D[];
  /** The two water-line endpoints, same coordinate space as rimPoints — kept
   * for backward compatibility with the depth maths, whether the operator
   * placed them as points or by dragging the line described below. */
  waterlinePoints: Point2D[];
  /** The water-line's own mathematical representation, when it was set via
   * the draggable-line editor: a midpoint and angle in source pixels
   * (domain/water-line.ts), which waterlinePoints above is derived from. */
  waterLineModel?: { midpointX: number; midpointY: number; angleRad: number; halfLengthPx: number };
  /** The ellipse/conic actually fitted to rimPoints — conic coefficients,
   * centre, semi-major/minor axes, rotation, RMS residual, inlier/rejected
   * counts and axis ratio all live here. Never a placeholder. */
  fit: EllipseFit;
  gravityVector?: GravityVector;
  pitchDeg?: number;
  rollDeg?: number;
  imageOrientation?: string;
  algorithmVersion: string;
}

export interface CalibrationPoint {
  id: string;
  createdAt: string;
  /** Water depth at calibration [m]. */
  depth: number;
  /** Wetted area at that depth [m²]. */
  area: number;
  /** Measured surface velocity [m/s]. */
  surfaceVelocity: number;
  /** Reference discharge from the certified instrument [m³/s]. */
  referenceFlow: number;
  /** Derived alpha = Qref / (A · Vsurface). */
  alpha: number;
  valid: boolean;
  invalidReason?: string;
  reference?: ReferenceInstrument;
  notes?: string;
}

export interface ReferenceInstrument {
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  certificate?: string;
  calibrationDate?: string;
  uncertainty?: string;
  notes?: string;
}

export interface MeasurementDraft {
  siteId?: string;
  siteName?: string;
  geometry: GeometryKind;
  dimensions: Dimensions;
  unit: LengthUnit;
  /** Water depth h [m]. */
  depth: number | null;
  levelMethod: LevelMethod;
  method: VelocityMethod;
  material?: string;
  /** Manning roughness n [-]. */
  roughness: number | null;
  /** Hydraulic gradient, always stored in ‰ whatever it was entered in. */
  slopePermille: number | null;
  /** The unit the gradient is entered and shown in. Display only. */
  slopeUnit?: SlopeUnit;
  /** Mean velocity for the manual method [m/s]. */
  manualVelocity: number | null;
  /** Camera-assisted level evidence. */
  photoUri?: string;
  gravity?: GravityVector;
  orientation?: string;
  /** Full camera-assisted level evidence — rim/waterline points, ellipse fit
   * and device pose, all in one frozen structure. */
  cameraLevelEvidence?: CameraLevelEvidence;
  /** Video velocity evidence. */
  videoUri?: string;
  videoDuration?: number;
  videoSource?: VideoSource;
  videoCapturedAt?: string;
  waterRoi?: WaterRoi;
  /** Defaults to FORWARD (the ROI's own drawn edge 1-2 -> 4-3 convention). */
  flowDirection?: FlowDirection;
  knownRoiDimensions?: KnownRoiDimensions;
  surfaceVelocity?: number;
  alpha: number;
  alphaProvenance: Provenance;
  location?: GeoLocation;
  notes?: string;
  /** Frozen sensor/camera evidence for this measurement — captured once, at
   * the moment of acquisition, and never recomputed from later Site settings. */
  sensorSnapshot?: SensorSnapshot;
}

/**
 * A Site's saved camera pose, for repeatability across return visits — not a
 * metric calibration. Heading is included only when it was captured with a
 * quality this app actually trusts (see estimateHeading in
 * domain/sensor-snapshot.ts, which as implemented never claims that), which
 * is why "Heading unavailable" is the expected, normal outcome (Phase 3/4):
 * pitch/roll carry the comparison, not the compass.
 */
export interface SiteCameraReference {
  pitchDeg?: number;
  rollDeg?: number;
  headingDeg?: number;
  cameraFingerprint?: CameraFingerprint;
  waterRoi?: WaterRoi;
  savedAt: string;
}

export interface Site {
  id: string;
  displayId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  draft: MeasurementDraft;
  alpha: number;
  alphaStatus: AlphaStatus;
  calibrationPoints: CalibrationPoint[];
  location?: GeoLocation;
  /** Live Flow (beta) reference camera pose. Preserved, not developed. */
  liveReferenceCamera?: Record<string, unknown>;
  /** Saved once, from a past successful measurement, to help re-aim the
   * camera the same way on a later visit (Phase 3). */
  referenceCameraOrientation?: SiteCameraReference;
}

export const DEFAULT_ALPHA = 0.85;
export const MEASUREMENT_VERSION = 1;
export const ALGORITHM_VERSION = 'ssiv-1.0.0';
