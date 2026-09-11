import type { FailureBase } from '../domain/result';
import type { ImageQualityMetrics } from './image-quality';

/**
 * The complete, closed set of video-velocity failures (specification §11.6).
 * Every path out of the camera/decoder/SSIV chain ends in exactly one of these
 * — there is no generic "something went wrong" and no silent return.
 */
export type SsivFailureCode =
  | 'INSUFFICIENT_TEXTURE'
  | 'INSUFFICIENT_VALID_VECTORS'
  | 'INVALID_ROI_CALIBRATION'
  | 'VIDEO_DECODE_FAILURE'
  | 'UNSTABLE_CAMERA'
  | 'UNDEREXPOSED_VIDEO'
  | 'EXCESSIVE_GLARE'
  | 'INSUFFICIENT_SURFACE_CONTRAST'
  | 'MOTION_BLUR_TOO_HIGH';

export interface SsivFailure extends FailureBase<SsivFailureCode> {
  /** i18n key for the corrective action the operator should take. */
  actionKey: string;
  /** Partial evidence, when the run got far enough to produce any. */
  evidence?: {
    totalVectors?: number;
    acceptedVectors?: number;
    stablePairs?: number;
    totalPairs?: number;
    medianCorrelation?: number;
    calibrationStatus?: string;
    imageQuality?: ImageQualityMetrics;
  };
}

const ACTION_KEYS: Record<SsivFailureCode, string> = {
  INSUFFICIENT_TEXTURE: 'ssiv.action.INSUFFICIENT_TEXTURE',
  INSUFFICIENT_VALID_VECTORS: 'ssiv.action.INSUFFICIENT_VALID_VECTORS',
  INVALID_ROI_CALIBRATION: 'ssiv.action.INVALID_ROI_CALIBRATION',
  VIDEO_DECODE_FAILURE: 'ssiv.action.VIDEO_DECODE_FAILURE',
  UNSTABLE_CAMERA: 'ssiv.action.UNSTABLE_CAMERA',
  UNDEREXPOSED_VIDEO: 'ssiv.action.UNDEREXPOSED_VIDEO',
  EXCESSIVE_GLARE: 'ssiv.action.EXCESSIVE_GLARE',
  INSUFFICIENT_SURFACE_CONTRAST: 'ssiv.action.INSUFFICIENT_SURFACE_CONTRAST',
  MOTION_BLUR_TOO_HIGH: 'ssiv.action.MOTION_BLUR_TOO_HIGH',
};

export const SSIV_FAILURE_CODES: readonly SsivFailureCode[] = Object.keys(
  ACTION_KEYS
) as SsivFailureCode[];

export function ssivFailure(
  code: SsivFailureCode,
  detail?: string,
  evidence?: SsivFailure['evidence']
): SsivFailure {
  return {
    code,
    messageKey: `ssiv.error.${code}`,
    actionKey: ACTION_KEYS[code],
    ...(detail ? { detail } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function isSsivFailure(value: unknown): value is SsivFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    SSIV_FAILURE_CODES.includes((value as SsivFailure).code)
  );
}
