import type { LengthUnit } from './units';

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
 * the top edge (points 1–2) towards the bottom edge (points 4–3). */
export interface WaterRoi {
  topLeft: NormalizedPoint;
  topRight: NormalizedPoint;
  bottomRight: NormalizedPoint;
  bottomLeft: NormalizedPoint;
}

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
  /** Hydraulic gradient as entered by the operator [‰]. */
  slopePermille: number | null;
  /** Mean velocity for the manual method [m/s]. */
  manualVelocity: number | null;
  /** Camera-assisted level evidence. */
  photoUri?: string;
  gravity?: GravityVector;
  orientation?: string;
  /** Video velocity evidence. */
  videoUri?: string;
  videoDuration?: number;
  videoSource?: VideoSource;
  videoCapturedAt?: string;
  waterRoi?: WaterRoi;
  knownRoiDimensions?: KnownRoiDimensions;
  surfaceVelocity?: number;
  alpha: number;
  alphaProvenance: Provenance;
  location?: GeoLocation;
  notes?: string;
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
}

export const DEFAULT_ALPHA = 0.85;
export const MEASUREMENT_VERSION = 1;
export const ALGORITHM_VERSION = 'ssiv-1.0.0';
