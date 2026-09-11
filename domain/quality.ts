import type { Provenance, QualityGrade, VelocityMethod } from './types';
import { classifyStability, type QualityBand } from './sensor-snapshot';
import {
  gradeContrast,
  gradeExposure,
  gradeGlare,
  gradeSharpness,
  type GlareBand,
  type ImageQualityMetrics,
} from '../video/image-quality';

/**
 * Quality, provenance and uncertainty are three separate concepts and are never
 * collapsed into one badge:
 *
 *  1. Provenance — where the number came from.
 *  2. Quality    — A / B / C / INVALID with a stated reason.
 *  3. Uncertainty — withheld. FLOWVISION has no validated propagation model, so
 *     it reports UNCERTAINTY NOT YET CALCULATED rather than a fabricated ±.
 */

export const UNCERTAINTY_WITHHELD = 'UNCERTAINTY_NOT_YET_CALCULATED' as const;

export interface QualityComponent {
  grade: QualityGrade;
  /** i18n key stating why this grade was given. Never empty. */
  reasonKey: string;
  detail?: string;
}

export interface QualityAssessment {
  geometry: QualityComponent;
  level: QualityComponent;
  velocity: QualityComponent;
  /** Present only for a video measurement with motion evidence. Absent, not
   * a fabricated grade, when no sensor snapshot exists — e.g. Manning/manual. */
  cameraStability?: QualityComponent;
  /** Present only for a video measurement whose clip carries image-quality
   * evidence (video/image-quality.ts's computeImageQuality). */
  imageQuality?: QualityComponent;
  overall: QualityComponent;
  /** Always the withheld sentinel until a validated model exists. */
  uncertainty: typeof UNCERTAINTY_WITHHELD;
}

const GRADE_ORDER: Record<QualityGrade, number> = { A: 3, B: 2, C: 1, INVALID: 0 };

export function worstGrade(...grades: QualityGrade[]): QualityGrade {
  return grades.reduce<QualityGrade>(
    (worst, grade) => (GRADE_ORDER[grade] < GRADE_ORDER[worst] ? grade : worst),
    'A'
  );
}

export interface GeometryQualityInput {
  provenance: Provenance;
  hasAdvisories: boolean;
  sectionValid: boolean;
}

export function gradeGeometry(input: GeometryQualityInput): QualityComponent {
  if (!input.sectionValid) {
    return { grade: 'INVALID', reasonKey: 'quality.geometry.sectionInvalid' };
  }
  if (input.hasAdvisories) {
    return { grade: 'B', reasonKey: 'quality.geometry.unusualDimensions' };
  }
  if (input.provenance === 'SITE') {
    return { grade: 'A', reasonKey: 'quality.geometry.fromSite' };
  }
  return { grade: 'B', reasonKey: 'quality.geometry.enteredOnce' };
}

export interface LevelQualityInput {
  provenance: Provenance;
  depthValid: boolean;
  /**
   * Present whenever the camera-assisted method was used. `evidence` is
   * absent (never a fabricated NaN/0 pair) when the draft carries no actual
   * ellipse fit — e.g. a depth carried over from an older record.
   */
  cameraAssisted?: { evidence?: { residualPx: number; pointCount: number } };
}

export function gradeLevel(input: LevelQualityInput): QualityComponent {
  if (!input.depthValid) {
    return { grade: 'INVALID', reasonKey: 'quality.level.depthInvalid' };
  }
  if (input.cameraAssisted) {
    // A small residual only proves the conic fits the clicked points. It does
    // not prove perspective accuracy, so camera-assisted level is capped at B.
    const evidence = input.cameraAssisted.evidence;
    if (!evidence || evidence.pointCount < 8 || !Number.isFinite(evidence.residualPx)) {
      return { grade: 'C', reasonKey: 'quality.level.cameraWeakFit' };
    }
    return { grade: 'B', reasonKey: 'quality.level.cameraNotMetrologicallyValidated' };
  }
  return { grade: 'A', reasonKey: 'quality.level.manualEntry' };
}

export interface VelocityQualityInput {
  method: VelocityMethod;
  velocityValid: boolean;
  /** Video method only. */
  video?: {
    acceptedVectors: number;
    totalVectors: number;
    calibrationStatus: 'VALID' | 'POOR' | 'INVALID';
    stablePairs: number;
  };
  /** Whether alpha is site-calibrated rather than assumed. */
  alphaCalibrated?: boolean;
}

export function gradeVelocity(input: VelocityQualityInput): QualityComponent {
  if (!input.velocityValid) {
    return { grade: 'INVALID', reasonKey: 'quality.velocity.invalid' };
  }

  if (input.method === 'video') {
    const video = input.video;
    if (!video) return { grade: 'INVALID', reasonKey: 'quality.velocity.noVideoEvidence' };
    if (video.calibrationStatus !== 'VALID') {
      return {
        grade: 'INVALID',
        reasonKey: 'quality.velocity.calibrationNotValid',
        detail: video.calibrationStatus,
      };
    }
    const ratio = video.totalVectors > 0 ? video.acceptedVectors / video.totalVectors : 0;
    if (video.acceptedVectors < 4) {
      return { grade: 'INVALID', reasonKey: 'quality.velocity.tooFewVectors' };
    }
    // Video velocity is experimental; it never reaches grade A.
    if (ratio >= 0.5 && video.acceptedVectors >= 10 && video.stablePairs >= 5) {
      return {
        grade: 'B',
        reasonKey: input.alphaCalibrated
          ? 'quality.velocity.videoStrongCalibratedAlpha'
          : 'quality.velocity.videoStrongAssumedAlpha',
        detail: `${video.acceptedVectors}/${video.totalVectors}`,
      };
    }
    return {
      grade: 'C',
      reasonKey: 'quality.velocity.videoWeak',
      detail: `${video.acceptedVectors}/${video.totalVectors}`,
    };
  }

  if (input.method === 'manning') {
    return { grade: 'B', reasonKey: 'quality.velocity.manningEstimate' };
  }

  return { grade: 'B', reasonKey: 'quality.velocity.manualEntry' };
}

/**
 * Camera-stability grade (Phase 2/14): a *gate* on the reported grade, never
 * a correction applied to the velocity itself — the RMS figures behind this
 * come from `domain/sensor-snapshot.ts`'s summarizeMotion and are stored
 * alongside the grade so the reason is always traceable to a measured value
 * and a stated threshold, never a bare label.
 */
export interface CameraStabilityInput {
  angularVelocityRmsDegPerSec?: number;
  accelerationRmsMps2?: number;
}

export function gradeCameraStability(input: CameraStabilityInput): QualityComponent {
  const band = classifyStability(input.angularVelocityRmsDegPerSec, input.accelerationRmsMps2);
  const detail =
    input.angularVelocityRmsDegPerSec !== undefined || input.accelerationRmsMps2 !== undefined
      ? `angularVelocityRms=${input.angularVelocityRmsDegPerSec?.toFixed(3) ?? 'n/a'}°/s, ` +
        `accelerationRms=${input.accelerationRmsMps2?.toFixed(3) ?? 'n/a'}m/s²`
      : undefined;
  if (band === 'UNKNOWN') {
    return { grade: 'C', reasonKey: 'quality.cameraStability.unknown', detail };
  }
  const grade: QualityGrade = band === 'GOOD' ? 'A' : band === 'ACCEPTABLE' ? 'B' : 'C';
  return { grade, reasonKey: `quality.cameraStability.${band.toLowerCase()}`, detail };
}

const IMAGE_BAND_GRADE: Record<QualityBand, QualityGrade> = { GOOD: 'A', ACCEPTABLE: 'B', POOR: 'C' };
const GLARE_BAND_GRADE: Record<GlareBand, QualityGrade> = { LOW: 'A', MODERATE: 'B', HIGH: 'C' };

/**
 * Image-quality grade (Phase 9/14) from the same metrics that gate SSIV
 * outright in video/image-quality.ts's refuseOnImageQuality — this is the
 * softer ACCEPTABLE/POOR shading for a clip that passed that hard floor.
 */
export function gradeImageQuality(input: ImageQualityMetrics): QualityComponent {
  const dimensions = [
    {
      key: 'exposure',
      grade: IMAGE_BAND_GRADE[gradeExposure(input)],
      detail: `meanLuminance=${input.meanLuminance.toFixed(1)}, dark=${(input.darkPixelFraction * 100).toFixed(0)}%`,
    },
    {
      key: 'contrast',
      grade: IMAGE_BAND_GRADE[gradeContrast(input)],
      detail: `localContrast=${input.localContrast.toFixed(2)}`,
    },
    {
      key: 'sharpness',
      grade: IMAGE_BAND_GRADE[gradeSharpness(input)],
      detail: `blurScore=${input.blurScore.toFixed(2)}`,
    },
    {
      key: 'glare',
      grade: GLARE_BAND_GRADE[gradeGlare(input)],
      detail: `glareScore=${(input.glareScore * 100).toFixed(1)}%`,
    },
  ];
  const grade = worstGrade(...dimensions.map((d) => d.grade));
  const weakest = dimensions.find((d) => d.grade === grade) ?? (dimensions[0] as (typeof dimensions)[number]);
  return { grade, reasonKey: `quality.imageQuality.${weakest.key}`, detail: weakest.detail };
}

export function assess(
  geometry: QualityComponent,
  level: QualityComponent,
  velocity: QualityComponent,
  extra?: { cameraStability?: QualityComponent; imageQuality?: QualityComponent }
): QualityAssessment {
  const components = [
    geometry,
    level,
    velocity,
    ...(extra?.cameraStability ? [extra.cameraStability] : []),
    ...(extra?.imageQuality ? [extra.imageQuality] : []),
  ];
  const grade = worstGrade(...components.map((component) => component.grade));
  const weakest = components.find((component) => component.grade === grade) ?? geometry;

  return {
    geometry,
    level,
    velocity,
    ...(extra?.cameraStability ? { cameraStability: extra.cameraStability } : {}),
    ...(extra?.imageQuality ? { imageQuality: extra.imageQuality } : {}),
    overall: {
      grade,
      reasonKey: weakest.reasonKey,
      detail: weakest.detail,
    },
    uncertainty: UNCERTAINTY_WITHHELD,
  };
}

export const PROVENANCE_LABEL_KEYS: Record<Provenance, string> = {
  SITE: 'provenance.site',
  ENTERED: 'provenance.entered',
  MEASURED: 'provenance.measured',
  MEASURED_VIDEO: 'provenance.measuredVideo',
  ASSUMED: 'provenance.assumed',
  CALIBRATED: 'provenance.calibrated',
  CALCULATED: 'provenance.calculated',
  ESTIMATED: 'provenance.estimated',
};
