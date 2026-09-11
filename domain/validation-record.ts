import { median } from './linalg';
import type { SavedMeasurement } from './measurement';
import type { KnownRoiDimensions, ReferenceInstrument, WaterRoi } from './types';
import type { CalibrationStatus } from '../video/types';

/**
 * Validation dataset model (Phase 18).
 *
 * This exists so sensor/camera conditions can later be correlated with
 * measurement error once real reference data accumulate — it does not decide
 * or encode any acceptance threshold itself. There is no "maximum acceptable
 * camera angle" or similar limit anywhere in this file, deliberately: those
 * can only come from analysing a real set of these records against known
 * reference discharges, which does not exist yet.
 *
 * A record's `reference*` fields come from an independent instrument the
 * operator supplies (see `ReferenceInstrument`, already used by Site
 * calibration) — they are never derived or guessed from the FlowVision result
 * itself.
 */
export interface ValidationRecord {
  id: string;
  measurementId: string;
  createdAt: string;

  /** Independently measured discharge, when the operator has one. */
  referenceFlowM3s?: number;
  /** Independently measured velocity, when the operator has one. */
  referenceVelocityMs?: number;
  referenceInstrument?: ReferenceInstrument;

  /** FlowVision's own saved result for the same measurement. */
  flowVisionFlowM3s?: number;
  flowVisionVelocityMs?: number;

  /** Camera angle at acquisition. */
  pitchDeg?: number;
  rollDeg?: number;
  /** Camera-motion evidence over the acquisition window. */
  angularVelocityRmsDegPerSec?: number;
  accelerationRmsMps2?: number;

  /** Image-quality evidence from the analysed clip. */
  imageMeanLuminance?: number;
  imageLocalContrast?: number;
  blurScore?: number;
  glareScore?: number;

  /** ROI geometry and the metric scale it was given. */
  waterRoi?: WaterRoi;
  knownRoiDimensions?: KnownRoiDimensions;

  /** Metric-calibration quality — a solver self-consistency check, not
   * independent proof of accuracy; see video/homography.ts. The numerical
   * closure error itself isn't in this list: SsivAnalysis doesn't retain the
   * Homography object it was built from, so there is nothing real to put
   * here yet — VALID/POOR/INVALID is the only calibration evidence a saved
   * measurement actually carries today. */
  calibrationStatus?: CalibrationStatus;

  /** SSIV run evidence. */
  acceptedVectorRatio?: number;
  /** Median SNR of the accepted vectors — a real per-vector value the SSIV
   * pipeline already computes (SsivVector.snr), not a derived estimate. */
  medianSnr?: number;

  /** Device/camera identity, for later lens/device-dependent comparisons. */
  deviceModel?: string;
  cameraFacing?: 'back' | 'front';
}

/**
 * Build a validation record from a completed measurement, plus an
 * independent reference value when the operator has one. Every field is
 * either read straight off the measurement's own evidence or left absent —
 * nothing here is computed from an assumption about what the "true" value
 * should be.
 */
export function buildValidationRecord(
  id: string,
  measurement: SavedMeasurement,
  reference?: { flowM3s?: number; velocityMs?: number; instrument?: ReferenceInstrument },
  createdAt = new Date().toISOString()
): ValidationRecord {
  const snapshot = measurement.sensorSnapshot;
  const analysis = measurement.videoAnalysis;

  const acceptedSnr = analysis
    ? [...analysis.vectors, ...analysis.ensemble].filter((v) => v.accepted).map((v) => v.snr)
    : [];

  return {
    id,
    measurementId: measurement.id,
    createdAt,
    ...(reference?.flowM3s !== undefined ? { referenceFlowM3s: reference.flowM3s } : {}),
    ...(reference?.velocityMs !== undefined ? { referenceVelocityMs: reference.velocityMs } : {}),
    ...(reference?.instrument ? { referenceInstrument: reference.instrument } : {}),
    ...(typeof measurement.flowM3s === 'number' ? { flowVisionFlowM3s: measurement.flowM3s } : {}),
    ...(measurement.surfaceVelocity !== undefined ? { flowVisionVelocityMs: measurement.surfaceVelocity } : {}),
    ...(snapshot?.motion.pitchDeg !== undefined ? { pitchDeg: snapshot.motion.pitchDeg } : {}),
    ...(snapshot?.motion.rollDeg !== undefined ? { rollDeg: snapshot.motion.rollDeg } : {}),
    ...(snapshot?.motion.angularVelocityRmsDegPerSec !== undefined
      ? { angularVelocityRmsDegPerSec: snapshot.motion.angularVelocityRmsDegPerSec }
      : {}),
    ...(snapshot?.motion.accelerationRmsMps2 !== undefined
      ? { accelerationRmsMps2: snapshot.motion.accelerationRmsMps2 }
      : {}),
    ...(snapshot?.imageQuality
      ? {
          imageMeanLuminance: snapshot.imageQuality.meanLuminance,
          imageLocalContrast: snapshot.imageQuality.localContrast,
          blurScore: snapshot.imageQuality.blurScore,
          glareScore: snapshot.imageQuality.glareScore,
        }
      : {}),
    ...(measurement.waterRoi ? { waterRoi: measurement.waterRoi } : {}),
    ...(measurement.perspectiveScale ? { knownRoiDimensions: measurement.perspectiveScale } : {}),
    ...(analysis ? { calibrationStatus: analysis.calibrationStatus } : {}),
    ...(analysis
      ? {
          acceptedVectorRatio: analysis.quality.acceptanceRatio,
          ...(acceptedSnr.length > 0 ? { medianSnr: median(acceptedSnr) } : {}),
        }
      : {}),
    ...(snapshot?.device.model ? { deviceModel: snapshot.device.model } : {}),
    ...(snapshot?.camera.facing ? { cameraFacing: snapshot.camera.facing } : {}),
  };
}
