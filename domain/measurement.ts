import { computeSection, type GeometryError } from './geometry';
import { manningVelocity, manualFlow, videoFlow, type HydraulicsError } from './hydraulics';
import { integrateVelocityAreaDischarge, type LateralVelocityColumn } from './lateral-profile';
import { buildReport, type PlausibilityReport } from './plausibility';
import {
  assess,
  gradeCameraStability,
  gradeGeometry,
  gradeImageQuality,
  gradeLevel,
  gradeVelocity,
  type QualityAssessment,
} from './quality';
import { err, ok, type Result } from './result';
import type {
  Dimensions,
  GeoLocation,
  GravityVector,
  KnownRoiDimensions,
  LengthUnit,
  MeasurementDraft,
  ProcessingStatus,
  Provenance,
  SectionProperties,
  VelocityMethod,
  WaterRoi,
} from './types';
import { ALGORITHM_VERSION, MEASUREMENT_VERSION } from './types';
import type { SsivAnalysis } from '../video/types';
import { lateralVelocityProfile } from '../video/lateral-profile';

/**
 * The saved record (specification §14).
 *
 * `raw` is an immutable snapshot of the evidence the result was computed from.
 * Once a measurement is written it is never edited in place — a re-analysis
 * produces a new record, so the chain of custody of a field measurement stays
 * intact.
 */
export interface SavedMeasurement {
  id: string;
  displayId?: string;
  createdAt: string;
  siteId?: string;
  siteName?: string;
  geometry: Dimensions['kind'];
  dimensions: Dimensions;
  /** Water depth [m]. */
  depth: number;
  /** Unit the operator entered dimensions in. Storage is always SI. */
  unit: LengthUnit;
  levelMethod: MeasurementDraft['levelMethod'];
  method: VelocityMethod;
  material?: string;
  /** Dimensionless slope actually used, when Manning was the method. */
  slope?: number;
  roughness?: number;
  /** Mean velocity [m/s]. */
  velocity?: number;
  photoUri?: string;
  gravity?: GravityVector;
  orientation?: string;
  cameraLevelRimPoints?: MeasurementDraft['cameraLevelRimPoints'];
  cameraLevelWaterlinePoints?: MeasurementDraft['cameraLevelWaterlinePoints'];
  cameraLevelFit?: MeasurementDraft['cameraLevelFit'];
  /** Frozen sensor/camera evidence — see MeasurementDraft.sensorSnapshot. */
  sensorSnapshot?: MeasurementDraft['sensorSnapshot'];
  videoUri?: string;
  videoDuration?: number;
  videoSource?: MeasurementDraft['videoSource'];
  videoCapturedAt?: string;
  waterRoi?: WaterRoi;
  /** The known ROI dimensions that fixed the metric scale. */
  perspectiveScale?: KnownRoiDimensions;
  videoAnalysis?: SsivAnalysis;
  surfaceVelocity?: number;
  alpha?: number;
  /** Velocity-area cross-check, when the ROI's column coverage allowed one. */
  lateralProfileFlowM3s?: number;
  lateralProfileColumnsUsed?: number;
  lateralProfileColumnsTotal?: number;
  location?: GeoLocation;
  measurementVersion: number;
  algorithmVersion: string;
  processingStatus: ProcessingStatus;
  /** h/D for circular sections. */
  fillRatio?: number;
  /** Discharge [m³/s]. Absent when the result is withheld — never 0 as a stand-in. */
  flowM3s?: number;
  area?: number;
  wettedPerimeter?: number;
  hydraulicRadius?: number;
  topWidth?: number;
  confidence: QualityAssessment['overall']['grade'];
  dataQuality: QualityAssessment;
  provenance: MeasurementProvenance;
  notes?: string;
  /** Immutable evidence snapshot. */
  raw: MeasurementRaw;
}

export interface MeasurementProvenance {
  geometry: Provenance;
  depth: Provenance;
  velocity: Provenance;
  alpha: Provenance;
  flow: Provenance;
}

export interface MeasurementRaw {
  draft: MeasurementDraft;
  section?: SectionProperties;
  videoAnalysis?: SsivAnalysis;
  plausibility: PlausibilityReport;
  computedAt: string;
  algorithmVersion: string;
  measurementVersion: number;
}

export type CalculationErrorCode = 'PLAUSIBILITY_BLOCKED' | 'GEOMETRY' | 'HYDRAULICS' | 'MISSING_INPUT';

export interface CalculationError {
  code: CalculationErrorCode;
  messageKey: string;
  detail?: string;
  geometryError?: GeometryError;
  hydraulicsError?: HydraulicsError;
  plausibility?: PlausibilityReport;
  /** The field the operator has to correct. */
  field?: string;
}

/**
 * The lateral-profile cross-check, when the ROI's column coverage allowed
 * one to be computed. Informational only — see lateral-profile.ts for why it
 * is never the number that gets saved as the measurement's own discharge.
 */
export interface LateralProfileOutcome {
  flowM3s: number;
  meanVelocity: number;
  columns: LateralVelocityColumn[];
  columnsUsed: number;
  columnsTotal: number;
}

export interface CalculationOutcome {
  section: SectionProperties;
  velocity: number;
  flowM3s: number;
  surfaceVelocity?: number;
  alpha?: number;
  slope?: number;
  lateralProfile?: LateralProfileOutcome;
  quality: QualityAssessment;
  plausibility: PlausibilityReport;
  provenance: MeasurementProvenance;
}

function plausibilityValues(draft: MeasurementDraft): Record<string, number | null | undefined> {
  const values: Record<string, number | null | undefined> = {
    depth: draft.depth,
    alpha: draft.alpha,
  };
  switch (draft.dimensions.kind) {
    case 'circular':
      values.diameter = draft.dimensions.diameter;
      break;
    case 'rectangular':
      values.width = draft.dimensions.width;
      break;
    case 'trapezoidal':
      values.bottomWidth = draft.dimensions.bottomWidth;
      break;
  }
  if (draft.method === 'manning') {
    values.roughness = draft.roughness;
    values.slopePermille = draft.slopePermille;
  }
  if (draft.method === 'manual') values.velocity = draft.manualVelocity;
  if (draft.method === 'video') {
    values.surfaceVelocity = draft.surfaceVelocity;
    if (draft.knownRoiDimensions) {
      values.roiWidthM = draft.knownRoiDimensions.widthM;
      values.roiLengthM = draft.knownRoiDimensions.lengthM;
    }
  }
  return values;
}

/**
 * Run the full calculation for a draft.
 *
 * `acknowledgedAdvisories` carries the operator's confirmation of unusual —
 * but physically possible — values. Blocking findings can never be waived.
 */
export function calculate(
  draft: MeasurementDraft,
  options?: { analysis?: SsivAnalysis; acknowledgedAdvisories?: boolean }
): Result<CalculationOutcome, CalculationError> {
  const plausibility = buildReport(plausibilityValues(draft));
  if (plausibility.blocked) {
    const first = plausibility.findings.find((finding) => finding.severity === 'blocking');
    return err({
      code: 'PLAUSIBILITY_BLOCKED',
      messageKey: first?.messageKey ?? 'plausibility.blocked',
      detail: first ? `${first.field}=${first.value}` : undefined,
      field: first?.field,
      plausibility,
    });
  }

  if (draft.depth === null || !Number.isFinite(draft.depth)) {
    return err({
      code: 'MISSING_INPUT',
      messageKey: 'calculation.error.missingDepth',
      field: 'depth',
      plausibility,
    });
  }

  const section = computeSection(draft.dimensions, draft.depth);
  if (!section.ok) {
    return err({
      code: 'GEOMETRY',
      messageKey: section.error.messageKey,
      detail: section.error.detail,
      geometryError: section.error,
      field: section.error.field,
      plausibility,
    });
  }

  const geometryProvenance: Provenance = draft.siteId ? 'SITE' : 'ENTERED';
  const depthProvenance: Provenance =
    draft.levelMethod === 'camera-assisted' ? 'MEASURED' : 'ENTERED';

  let velocity: number;
  let flowM3s: number;
  let surfaceVelocity: number | undefined;
  let alpha: number | undefined;
  let slope: number | undefined;
  let velocityProvenance: Provenance;
  let lateralProfileOutcome: LateralProfileOutcome | undefined;

  switch (draft.method) {
    case 'manning': {
      if (draft.roughness === null || draft.slopePermille === null) {
        return err({
          code: 'MISSING_INPUT',
          messageKey: 'calculation.error.missingManningInput',
          field: draft.roughness === null ? 'roughness' : 'slope',
          plausibility,
        });
      }
      const result = manningVelocity(section.value, draft.roughness, draft.slopePermille);
      if (!result.ok) {
        return err({
          code: 'HYDRAULICS',
          messageKey: result.error.messageKey,
          detail: result.error.detail,
          hydraulicsError: result.error,
          field: result.error.field,
          plausibility,
        });
      }
      velocity = result.value.velocity;
      flowM3s = result.value.flow;
      slope = result.value.slope;
      velocityProvenance = 'ESTIMATED';
      break;
    }
    case 'manual': {
      if (draft.manualVelocity === null) {
        return err({
          code: 'MISSING_INPUT',
          messageKey: 'calculation.error.missingVelocity',
          field: 'velocity',
          plausibility,
        });
      }
      const result = manualFlow(section.value, draft.manualVelocity);
      if (!result.ok) {
        return err({
          code: 'HYDRAULICS',
          messageKey: result.error.messageKey,
          detail: result.error.detail,
          hydraulicsError: result.error,
          field: result.error.field,
          plausibility,
        });
      }
      velocity = result.value.velocity;
      flowM3s = result.value.flow;
      velocityProvenance = 'ENTERED';
      break;
    }
    case 'video': {
      const measured = options?.analysis?.surfaceVelocity ?? draft.surfaceVelocity;
      if (measured === undefined || !Number.isFinite(measured)) {
        return err({
          code: 'MISSING_INPUT',
          messageKey: 'calculation.error.missingSurfaceVelocity',
          field: 'surfaceVelocity',
          plausibility,
        });
      }
      const result = videoFlow(section.value, measured, draft.alpha);
      if (!result.ok) {
        return err({
          code: 'HYDRAULICS',
          messageKey: result.error.messageKey,
          detail: result.error.detail,
          hydraulicsError: result.error,
          field: result.error.field,
          plausibility,
        });
      }
      velocity = result.value.meanVelocity;
      flowM3s = result.value.flow;
      surfaceVelocity = result.value.surfaceVelocity;
      alpha = result.value.alpha;
      velocityProvenance = 'MEASURED_VIDEO';

      // An informational cross-check only — see LateralProfileOutcome. A
      // draft carrying an analysis from a previous run but no fresh one this
      // time (options?.analysis undefined) has no per-column evidence to
      // build it from, so it is silently absent rather than guessed.
      if (options?.analysis) {
        const profile = lateralVelocityProfile(options.analysis);
        const integrated = integrateVelocityAreaDischarge(
          draft.dimensions,
          draft.depth,
          section.value.topWidth,
          section.value.area,
          profile.columns,
          draft.alpha,
          profile.columnsTotal
        );
        if (integrated.ok) {
          lateralProfileOutcome = {
            flowM3s: integrated.value.flow,
            meanVelocity: integrated.value.meanVelocity,
            columns: profile.columns,
            columnsUsed: integrated.value.columnsUsed,
            columnsTotal: integrated.value.columnsTotal,
          };
        }
      }
      break;
    }
    default: {
      const exhaustive: never = draft.method;
      return err({
        code: 'MISSING_INPUT',
        messageKey: 'calculation.error.unknownMethod',
        detail: String(exhaustive),
        plausibility,
      });
    }
  }

  const analysis = options?.analysis;
  const quality = assess(
    gradeGeometry({
      provenance: geometryProvenance,
      hasAdvisories: plausibility.advisories.some((finding) =>
        ['diameter', 'width', 'bottomWidth'].includes(finding.field)
      ),
      sectionValid: true,
    }),
    gradeLevel({
      provenance: depthProvenance,
      depthValid: true,
      ...(draft.levelMethod === 'camera-assisted'
        ? {
            cameraAssisted: draft.cameraLevelFit
              ? {
                  residualPx: draft.cameraLevelFit.residual,
                  pointCount: draft.cameraLevelFit.inlierCount,
                }
              // No fit evidence on the draft (e.g. a depth carried over from
              // an older record) — grade it as the weak, unverifiable case
              // rather than assume a fit that was never actually run.
              : { residualPx: NaN, pointCount: 0 },
          }
        : {}),
    }),
    gradeVelocity({
      method: draft.method,
      velocityValid: Number.isFinite(velocity) && velocity > 0,
      ...(analysis
        ? {
            video: {
              acceptedVectors: analysis.quality.acceptedVectors,
              totalVectors: analysis.quality.totalVectors,
              calibrationStatus: analysis.calibrationStatus,
              stablePairs: analysis.quality.stablePairs,
            },
          }
        : {}),
      alphaCalibrated: draft.alphaProvenance === 'CALIBRATED',
    }),
    draft.method === 'video' && draft.sensorSnapshot
      ? {
          ...(draft.sensorSnapshot.motion
            ? {
                cameraStability: gradeCameraStability({
                  angularVelocityRmsDegPerSec: draft.sensorSnapshot.motion.angularVelocityRmsDegPerSec,
                  accelerationRmsMps2: draft.sensorSnapshot.motion.accelerationRmsMps2,
                }),
              }
            : {}),
          ...(draft.sensorSnapshot.imageQuality
            ? { imageQuality: gradeImageQuality(draft.sensorSnapshot.imageQuality) }
            : {}),
        }
      : undefined
  );

  return ok({
    section: section.value,
    velocity,
    flowM3s,
    ...(surfaceVelocity !== undefined ? { surfaceVelocity } : {}),
    ...(alpha !== undefined ? { alpha } : {}),
    ...(slope !== undefined ? { slope } : {}),
    ...(lateralProfileOutcome !== undefined ? { lateralProfile: lateralProfileOutcome } : {}),
    quality,
    plausibility,
    provenance: {
      geometry: geometryProvenance,
      depth: depthProvenance,
      velocity: velocityProvenance,
      alpha: draft.alphaProvenance,
      flow: 'CALCULATED',
    },
  });
}

/** Assemble the immutable saved record from a draft and its calculation. */
export function buildSavedMeasurement(
  id: string,
  displayId: string,
  draft: MeasurementDraft,
  outcome: CalculationOutcome,
  options?: { analysis?: SsivAnalysis; createdAt?: string }
): SavedMeasurement {
  const createdAt = options?.createdAt ?? new Date().toISOString();
  const analysis = options?.analysis;

  return {
    id,
    displayId,
    createdAt,
    ...(draft.siteId ? { siteId: draft.siteId } : {}),
    ...(draft.siteName ? { siteName: draft.siteName } : {}),
    geometry: draft.dimensions.kind,
    dimensions: draft.dimensions,
    depth: draft.depth as number,
    unit: draft.unit,
    levelMethod: draft.levelMethod,
    method: draft.method,
    ...(draft.material ? { material: draft.material } : {}),
    ...(outcome.slope !== undefined ? { slope: outcome.slope } : {}),
    ...(draft.roughness !== null ? { roughness: draft.roughness } : {}),
    velocity: outcome.velocity,
    ...(draft.photoUri ? { photoUri: draft.photoUri } : {}),
    ...(draft.gravity ? { gravity: draft.gravity } : {}),
    ...(draft.orientation ? { orientation: draft.orientation } : {}),
    ...(draft.cameraLevelRimPoints ? { cameraLevelRimPoints: draft.cameraLevelRimPoints } : {}),
    ...(draft.cameraLevelWaterlinePoints
      ? { cameraLevelWaterlinePoints: draft.cameraLevelWaterlinePoints }
      : {}),
    ...(draft.cameraLevelFit ? { cameraLevelFit: draft.cameraLevelFit } : {}),
    ...(draft.sensorSnapshot ? { sensorSnapshot: draft.sensorSnapshot } : {}),
    ...(draft.videoUri ? { videoUri: draft.videoUri } : {}),
    ...(draft.videoDuration !== undefined ? { videoDuration: draft.videoDuration } : {}),
    ...(draft.videoSource ? { videoSource: draft.videoSource } : {}),
    ...(draft.videoCapturedAt ? { videoCapturedAt: draft.videoCapturedAt } : {}),
    ...(draft.waterRoi ? { waterRoi: draft.waterRoi } : {}),
    ...(draft.knownRoiDimensions ? { perspectiveScale: draft.knownRoiDimensions } : {}),
    ...(analysis ? { videoAnalysis: analysis } : {}),
    ...(outcome.surfaceVelocity !== undefined ? { surfaceVelocity: outcome.surfaceVelocity } : {}),
    ...(outcome.alpha !== undefined ? { alpha: outcome.alpha } : {}),
    ...(outcome.lateralProfile
      ? {
          lateralProfileFlowM3s: outcome.lateralProfile.flowM3s,
          lateralProfileColumnsUsed: outcome.lateralProfile.columnsUsed,
          lateralProfileColumnsTotal: outcome.lateralProfile.columnsTotal,
        }
      : {}),
    ...(draft.location ? { location: draft.location } : {}),
    measurementVersion: MEASUREMENT_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    processingStatus: draft.method === 'video' ? (analysis ? 'PROCESSED' : 'CAPTURED') : 'PROCESSED',
    ...(outcome.section.fillRatio !== undefined ? { fillRatio: outcome.section.fillRatio } : {}),
    flowM3s: outcome.flowM3s,
    area: outcome.section.area,
    wettedPerimeter: outcome.section.wettedPerimeter,
    hydraulicRadius: outcome.section.hydraulicRadius,
    topWidth: outcome.section.topWidth,
    confidence: outcome.quality.overall.grade,
    dataQuality: outcome.quality,
    provenance: outcome.provenance,
    ...(draft.notes ? { notes: draft.notes } : {}),
    raw: {
      draft: JSON.parse(JSON.stringify(draft)) as MeasurementDraft,
      section: outcome.section,
      ...(analysis ? { videoAnalysis: analysis } : {}),
      plausibility: outcome.plausibility,
      computedAt: createdAt,
      algorithmVersion: ALGORITHM_VERSION,
      measurementVersion: MEASUREMENT_VERSION,
    },
  };
}
