import type { Provenance, QualityGrade, VelocityMethod } from './types';

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
  /** Camera-assisted level residual, when that method was used. */
  cameraAssisted?: { residualPx: number; pointCount: number };
}

export function gradeLevel(input: LevelQualityInput): QualityComponent {
  if (!input.depthValid) {
    return { grade: 'INVALID', reasonKey: 'quality.level.depthInvalid' };
  }
  if (input.cameraAssisted) {
    // A small residual only proves the conic fits the clicked points. It does
    // not prove perspective accuracy, so camera-assisted level is capped at B.
    const { residualPx, pointCount } = input.cameraAssisted;
    if (pointCount < 8 || !Number.isFinite(residualPx)) {
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

export function assess(
  geometry: QualityComponent,
  level: QualityComponent,
  velocity: QualityComponent
): QualityAssessment {
  const grade = worstGrade(geometry.grade, level.grade, velocity.grade);
  const weakest =
    [geometry, level, velocity].find((component) => component.grade === grade) ?? geometry;

  return {
    geometry,
    level,
    velocity,
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
