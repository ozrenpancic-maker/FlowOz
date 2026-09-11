/**
 * Canonical sensor/camera evidence model — the one shape used by Video
 * Velocity, Camera Level, Measurement Detail, the PDF/CSV exporters and (when
 * it resumes development) Live Flow. Every screen that touches a sensor
 * builds one of these rather than inventing its own shape, so a value never
 * has to be recomputed or reinterpreted twice.
 *
 * Ground rule, applied throughout this file and everywhere it is populated:
 * a value is either genuinely read from the platform, or it is absent/an
 * explicit `available: false`. Nothing here is ever guessed, defaulted from a
 * device-model lookup table, or synthesised to make a UI row look complete.
 * This is pure, native-free domain code — the modules that actually touch
 * `expo-sensors` / `expo-camera` / `expo-device` live under `sensors/` and
 * `video/`, and hand their readings to the classification functions below.
 */

import type { ImageQualityMetrics } from '../video/image-quality';

export type Tri = 'YES' | 'NO' | 'UNKNOWN';
export type QualityBand = 'GOOD' | 'ACCEPTABLE' | 'POOR';

/**
 * Where a video's frame timing actually came from. `WEBVIEW_MEDIA_TIME` is
 * the only source this build has: the WebView decoder reads the HTML5
 * `<video>` element's own `currentTime` after each seek, which is a real
 * measured value but not a full native per-frame presentation-timestamp
 * (PTS) track — see CAMERA_CAPABILITY_MATRIX. A future native decoder could
 * add a genuine PTS-based source; this type is left open for that, but this
 * build never claims one it doesn't have.
 */
export type TimingSource = 'WEBVIEW_MEDIA_TIME';

export interface DeviceInfo {
  manufacturer?: string;
  model?: string;
  androidVersion?: string;
  /** This build's own app.json version. */
  appVersion: string;
  algorithmVersion: string;
}

/**
 * What the current Expo/Android stack can and cannot report about the
 * camera actually used. See CAMERA_CAPABILITY_MATRIX below for the audited,
 * source-inspected basis of every `available` flag here — none of it is a
 * guess, and several fields (lensId, focalLengthMm, iso, exposureTimeSec,
 * focusDistanceM, intrinsics, distortion) are structurally incapable of being
 * populated on Android through expo-camera as it exists today.
 */
export interface CameraMetadata {
  available: boolean;
  facing?: 'back' | 'front';
  /** Not available through expo-camera on Android — reserved for a future
   * native camera layer. See CAMERA_CAPABILITY_MATRIX. */
  lensId?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  /** From the container/track metadata (e.g. expo-video's VideoTrack.frameRate). */
  nominalFps?: number;
  /** From the decoder's own measured frame-pair spacing (1 / median actual Δt). */
  actualFps?: number;
  /** The decoder's measured spacing between a pair's two frames [s] — the
   * same underlying measurement as actualFps, expressed directly in time
   * rather than converted to a rate. */
  observedFrameIntervalS?: number;
  /** The Δt this measurement's velocity was actually divided by [s]. In this
   * build it is the same measured value as observedFrameIntervalS (there is
   * no separate smoothing/estimation step) — stored as its own field so a
   * future pipeline that combines several differently-sourced intervals can
   * report them distinctly without a schema change. */
  actualProcessingDeltaT?: number;
  /** Explicit source of the two fields above. Never populated for a value
   * this build did not actually measure. */
  timingSource?: TimingSource;
  /** Normalised 0–1, the value the app itself requested — expo-camera does not
   * expose a device-specific optical multiplier ("2x") to convert this to. */
  zoom?: number;
  /** None of the following are exposed by expo-camera's CameraView on
   * Android or iOS as of this build; see CAMERA_CAPABILITY_MATRIX. */
  focalLengthMm?: number;
  exposureTimeSec?: number;
  iso?: number;
  focusDistanceM?: number;
  intrinsicsAvailable: boolean;
  fx?: number;
  fy?: number;
  cx?: number;
  cy?: number;
  distortionAvailable: boolean;
  distortionCoefficients?: number[];
}

/**
 * A single interval's worth of camera-motion statistics: sampled throughout
 * the actual acquisition window (a video recording, or the moment a level
 * photo is taken), never a single instantaneous reading.
 */
export interface MotionSummary {
  accelerometerAvailable: boolean;
  gyroscopeAvailable: boolean;
  deviceMotionAvailable: boolean;
  /** Degrees, device tilt forward/back. */
  pitchDeg?: number;
  /** Degrees, device tilt left/right. */
  rollDeg?: number;
  /** Degrees; only ever populated from DeviceMotion's own rotation reading,
   * which drifts without a magnetometer fusion FlowVision does not perform —
   * treat as a rough relative reading, not a stable heading. */
  yawDeg?: number;
  angularVelocityRmsDegPerSec?: number;
  accelerationRmsMps2?: number;
  /** g-units (1 g = 9.80665 m/s²), the raw accelerometer reading — same
   * convention as the existing GravityVector used elsewhere in this app. */
  gravityVector?: { x: number; y: number; z: number };
  /** How many samples the RMS figures were computed over — without this a
   * "0.2°/s RMS" figure from 2 samples and one from 200 look identical. */
  sampleCount?: number;
  /** Actual sampled window length [s], which may be shorter than the
   * requested recording duration if sampling started or stopped late. */
  windowDurationS?: number;
}

export interface LocationSnapshot {
  available: boolean;
  latitude?: number;
  longitude?: number;
  accuracyM?: number;
  altitudeM?: number;
  altitudeAccuracyM?: number;
}

export type MagneticQuality = 'GOOD' | 'QUESTIONABLE' | 'UNAVAILABLE';

export interface MagneticSnapshot {
  available: boolean;
  headingDeg?: number;
  quality: MagneticQuality;
}

/**
 * A heading derived from one raw magnetometer reading, using the simple
 * flat-device compass formula (no tilt compensation against the
 * simultaneously-captured gravity vector). Deliberately never reported as
 * GOOD: getting a tilt-compensated compass sign convention right without a
 * physical device to validate against is exactly the kind of thing this
 * project's "never invent or estimate a sensor value" rule exists to guard
 * against, and a steel pipe, rebar cage or nearby machinery can throw off any
 * magnetometer regardless of how well the maths is done. The number is real,
 * measured, and may be useful for a later Site-repeatability check — it is
 * just never trusted the way pitch/roll are (Phase 3/4).
 */
export function estimateHeading(magnetic: Vector3 | undefined): {
  headingDeg?: number;
  quality: MagneticQuality;
} {
  if (!magnetic) return { quality: 'UNAVAILABLE' };
  const headingDeg = ((Math.atan2(magnetic.y, magnetic.x) * 180) / Math.PI + 360) % 360;
  if (!Number.isFinite(headingDeg)) return { quality: 'UNAVAILABLE' };
  return { headingDeg, quality: 'QUESTIONABLE' };
}

export interface PressureSnapshot {
  available: boolean;
  atmosphericPressureHpa?: number;
}

export interface DepthCapabilitySnapshot {
  /** No native ARCore/depth probe is wired up — adding one only to populate a
   * capability screen would mean a large native dependency for a display-only
   * feature, which this phase deliberately does not do. Always UNKNOWN today. */
  arcoreSupported: Tri;
  depthSupported: Tri;
  tofAccessible: Tri;
}

/**
 * Camera metadata capability audit (Phase 5), grounded by reading the
 * installed expo-camera/expo-video type definitions rather than guessed from
 * documentation or memory — see the source files named below. Re-check this
 * table whenever expo-camera/expo-video are upgraded, since a newer SDK
 * could genuinely add one of these.
 */
export type CameraCapabilityStatus =
  | 'YES'
  | 'NO'
  | 'REQUESTED_ONLY'
  | 'NOT AVAILABLE THROUGH CURRENT STACK'
  | 'FUTURE NATIVE IMPLEMENTATION';

export interface CameraCapabilityRow {
  property: string;
  status: CameraCapabilityStatus;
  note: string;
}

export const CAMERA_CAPABILITY_MATRIX: readonly CameraCapabilityRow[] = [
  { property: 'Resolution (source width/height)', status: 'YES', note: 'From the decoded video track / captured photo.' },
  {
    property: 'Nominal FPS',
    status: 'YES',
    note: "expo-video VideoTrack.frameRate — the container's own declared rate.",
  },
  {
    property: 'Actual frame timestamps',
    status: 'REQUESTED_ONLY',
    note:
      'The WebView decoder reads video.currentTime after each seek, giving a real measured Δt between the two decoded frames — but not a full per-frame presentation-timestamp track. See Phase 8.',
  },
  {
    property: 'Focal length',
    status: 'NOT AVAILABLE THROUGH CURRENT STACK',
    note: 'Not exposed by CameraViewProps on any platform.',
  },
  {
    property: 'ISO',
    status: 'NOT AVAILABLE THROUGH CURRENT STACK',
    note: 'Not exposed by CameraViewProps on any platform (WebCameraSettings is web-only and unused here).',
  },
  {
    property: 'Exposure time',
    status: 'NOT AVAILABLE THROUGH CURRENT STACK',
    note: 'Not exposed by CameraViewProps on any platform.',
  },
  {
    property: 'Focus distance',
    status: 'NOT AVAILABLE THROUGH CURRENT STACK',
    note: 'Not exposed by CameraViewProps on any platform.',
  },
  {
    property: 'Camera/lens ID',
    status: 'NOT AVAILABLE THROUGH CURRENT STACK',
    note: 'selectedLens/getAvailableLenses/onAvailableLensesChanged are documented @platform ios only.',
  },
  { property: 'Zoom ratio', status: 'YES', note: 'CameraViewProps.zoom, normalised 0–1, cross-platform — but the value the app itself set, not a device-reported optical multiplier.' },
  {
    property: 'Camera intrinsics (fx/fy/cx/cy)',
    status: 'FUTURE NATIVE IMPLEMENTATION',
    note: 'No intrinsics API anywhere in expo-camera — would require a native Camera2/AVFoundation layer.',
  },
  {
    property: 'Distortion coefficients',
    status: 'FUTURE NATIVE IMPLEMENTATION',
    note: 'No distortion API anywhere in expo-camera — would require a native Camera2/AVFoundation layer.',
  },
] as const;

export interface SensorSnapshot {
  /** Epoch ms, when this snapshot was frozen. */
  timestamp: number;
  device: DeviceInfo;
  camera: CameraMetadata;
  motion: MotionSummary;
  location?: LocationSnapshot;
  magnetic?: MagneticSnapshot;
  pressure?: PressureSnapshot;
  /** The same shape video/image-quality.ts's computeImageQuality returns —
   * reused directly rather than duplicated, so grading and storage can never
   * silently drift apart. */
  imageQuality?: ImageQualityMetrics;
  depthCapability?: DepthCapabilitySnapshot;
}

/**
 * Configurable, explicit thresholds behind every GOOD/ACCEPTABLE/POOR label
 * this module produces. Nothing is graded off an unstated number — see Phase
 * 14 (`domain/quality.ts`'s gradeCameraStability) for how these are always
 * shown alongside the measured value and the threshold that produced the
 * grade, never as a bare label.
 */
export const STABILITY_THRESHOLDS = Object.freeze({
  angularVelocityGoodDegPerSec: 0.5,
  angularVelocityAcceptableDegPerSec: 2,
  accelerationGoodMps2: 0.3,
  accelerationAcceptableMps2: 1.0,
} as const);

export const ORIENTATION_ALIGNMENT_THRESHOLDS = Object.freeze({
  pitchGoodDeg: 2,
  pitchAcceptableDeg: 5,
  rollGoodDeg: 2,
  rollAcceptableDeg: 5,
  headingGoodDeg: 10,
  headingAcceptableDeg: 25,
} as const);

/**
 * Camera stability grade from the two RMS figures measured over the actual
 * acquisition window. Used as a quality *gate*, not a correction factor: a
 * POOR reading degrades the measurement's grade, it never adjusts the
 * reported velocity.
 */
export function classifyStability(
  angularVelocityRmsDegPerSec: number | undefined,
  accelerationRmsMps2: number | undefined
): QualityBand | 'UNKNOWN' {
  if (angularVelocityRmsDegPerSec === undefined && accelerationRmsMps2 === undefined) return 'UNKNOWN';
  const t = STABILITY_THRESHOLDS;
  const bands: QualityBand[] = [];
  if (angularVelocityRmsDegPerSec !== undefined) {
    bands.push(
      angularVelocityRmsDegPerSec <= t.angularVelocityGoodDegPerSec
        ? 'GOOD'
        : angularVelocityRmsDegPerSec <= t.angularVelocityAcceptableDegPerSec
          ? 'ACCEPTABLE'
          : 'POOR'
    );
  }
  if (accelerationRmsMps2 !== undefined) {
    bands.push(
      accelerationRmsMps2 <= t.accelerationGoodMps2
        ? 'GOOD'
        : accelerationRmsMps2 <= t.accelerationAcceptableMps2
          ? 'ACCEPTABLE'
          : 'POOR'
    );
  }
  const order: Record<QualityBand, number> = { GOOD: 2, ACCEPTABLE: 1, POOR: 0 };
  return bands.reduce((worst, band) => (order[band] < order[worst] ? band : worst), 'GOOD');
}

/** Root-mean-square of a sample array. NaN for an empty array — callers must
 * treat that as "no samples", never as a real zero reading. */
export function rms(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sumSq = values.reduce((sum, v) => sum + v * v, 0);
  return Math.sqrt(sumSq / values.length);
}

function average(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Standard gravity, m/s² — used only to convert the accelerometer's g-unit
 * reading, never to invent an acceleration value. */
export const STANDARD_GRAVITY_MPS2 = 9.80665;

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Raw samples collected by `sensors/motion-sampler.ts` throughout one
 * acquisition window (a video recording, or the instant a level photo is
 * taken). Kept as a plain data shape so the aggregation below — the part
 * worth getting right and testing — never has to touch a native sensor API
 * itself.
 */
export interface RawMotionSamples {
  accelerometerAvailable: boolean;
  gyroscopeAvailable: boolean;
  deviceMotionAvailable: boolean;
  /** Accelerometer readings, g-units, over the window. */
  gravitySamples: readonly Vector3[];
  /** Angular speed magnitude per sample, deg/s — from DeviceMotion.rotationRate
   * (documented in deg/s) or, as a fallback, the Gyroscope (documented in
   * rad/s, converted here to match). */
  angularSpeedsDegPerSec: readonly number[];
  /** DeviceMotion.acceleration per sample, m/s², gravity already removed by
   * the platform. Empty when DeviceMotion did not provide this channel. */
  linearAccelSamplesMps2: readonly Vector3[];
  /** Actual sampled window length [s]. */
  windowDurationS?: number;
}

/**
 * Reduce raw samples to the summary FlowVision actually stores and grades.
 *
 * Pitch/roll come from the accelerometer's own gravity-dominated reading via
 * plain trigonometry on a normalised direction — not from DeviceMotion's
 * `rotation` field, whose alpha/beta/gamma units expo-sensors does not
 * document (unlike `rotationRate` and `acceleration`, which are explicit).
 * Guessing that unit would risk a silent ~57× error; deriving the angle from
 * a vector this module already trusts for the existing gravity capture does
 * not.
 */
export function summarizeMotion(raw: RawMotionSamples): MotionSummary {
  const lastGravity = raw.gravitySamples[raw.gravitySamples.length - 1];
  const pitchDeg = lastGravity
    ? (Math.atan2(-lastGravity.x, Math.hypot(lastGravity.y, lastGravity.z)) * 180) / Math.PI
    : undefined;
  const rollDeg = lastGravity ? (Math.atan2(lastGravity.y, lastGravity.z) * 180) / Math.PI : undefined;

  const angularVelocityRmsDegPerSec =
    raw.angularSpeedsDegPerSec.length > 0 ? rms(raw.angularSpeedsDegPerSec) : undefined;

  let accelerationRmsMps2: number | undefined;
  if (raw.linearAccelSamplesMps2.length > 0) {
    accelerationRmsMps2 = rms(raw.linearAccelSamplesMps2.map((s) => Math.hypot(s.x, s.y, s.z)));
  } else if (raw.gravitySamples.length > 1) {
    // No DeviceMotion linear-acceleration channel: fall back to the raw
    // accelerometer, mean-removed to strip the constant ~1g gravity offset
    // and the device's static tilt, leaving the genuine shake component, then
    // converted from g to m/s².
    const meanX = average(raw.gravitySamples.map((s) => s.x));
    const meanY = average(raw.gravitySamples.map((s) => s.y));
    const meanZ = average(raw.gravitySamples.map((s) => s.z));
    accelerationRmsMps2 =
      rms(raw.gravitySamples.map((s) => Math.hypot(s.x - meanX, s.y - meanY, s.z - meanZ))) *
      STANDARD_GRAVITY_MPS2;
  }

  return {
    accelerometerAvailable: raw.accelerometerAvailable,
    gyroscopeAvailable: raw.gyroscopeAvailable,
    deviceMotionAvailable: raw.deviceMotionAvailable,
    ...(pitchDeg !== undefined && Number.isFinite(pitchDeg) ? { pitchDeg } : {}),
    ...(rollDeg !== undefined && Number.isFinite(rollDeg) ? { rollDeg } : {}),
    ...(angularVelocityRmsDegPerSec !== undefined && Number.isFinite(angularVelocityRmsDegPerSec)
      ? { angularVelocityRmsDegPerSec }
      : {}),
    ...(accelerationRmsMps2 !== undefined && Number.isFinite(accelerationRmsMps2)
      ? { accelerationRmsMps2 }
      : {}),
    ...(lastGravity ? { gravityVector: lastGravity } : {}),
    sampleCount: raw.gravitySamples.length,
    ...(raw.windowDurationS !== undefined ? { windowDurationS: raw.windowDurationS } : {}),
  };
}

export interface OrientationReference {
  pitchDeg: number;
  rollDeg: number;
  /** Present only when the reference was saved with a trustworthy heading. */
  headingDeg?: number;
}

export interface OrientationAlignmentAxis {
  deltaDeg: number;
  band: QualityBand;
}

export interface OrientationAlignment {
  pitch?: OrientationAlignmentAxis;
  roll?: OrientationAlignmentAxis;
  /** Absent whenever either side lacks a trustworthy heading — heading is
   * never required, per Phase 3/4: steel pipes and rebar can corrupt it, and
   * pitch/roll alone are enough to re-aim the camera the same way. */
  heading?: OrientationAlignmentAxis;
}

function axisAlignment(deltaDeg: number, goodDeg: number, acceptableDeg: number): OrientationAlignmentAxis {
  const magnitude = Math.abs(deltaDeg);
  return {
    deltaDeg,
    band: magnitude <= goodDeg ? 'GOOD' : magnitude <= acceptableDeg ? 'ACCEPTABLE' : 'POOR',
  };
}

/**
 * Compare the current camera pose with a Site's saved reference orientation.
 * Heading is compared only when both sides have one — a missing or dropped
 * heading never blocks the pitch/roll comparison, which the spec treats as
 * the higher-trust signal.
 */
export function compareOrientation(
  current: { pitchDeg?: number; rollDeg?: number; headingDeg?: number },
  reference: OrientationReference
): OrientationAlignment {
  const t = ORIENTATION_ALIGNMENT_THRESHOLDS;
  const alignment: OrientationAlignment = {};
  if (current.pitchDeg !== undefined) {
    alignment.pitch = axisAlignment(current.pitchDeg - reference.pitchDeg, t.pitchGoodDeg, t.pitchAcceptableDeg);
  }
  if (current.rollDeg !== undefined) {
    alignment.roll = axisAlignment(current.rollDeg - reference.rollDeg, t.rollGoodDeg, t.rollAcceptableDeg);
  }
  if (current.headingDeg !== undefined && reference.headingDeg !== undefined) {
    let delta = current.headingDeg - reference.headingDeg;
    // Shortest signed angular difference around the compass circle.
    delta = ((delta + 180) % 360 + 360) % 360 - 180;
    alignment.heading = axisAlignment(delta, t.headingGoodDeg, t.headingAcceptableDeg);
  }
  return alignment;
}

/**
 * A fingerprint of the camera configuration actually used for a measurement
 * — enough to detect "the operator switched to the ultra-wide lens" or
 * "zoom crept up" between a Site's saved calibration and a later
 * measurement. Not a lens identity (Android does not expose one through this
 * stack — see CAMERA_CAPABILITY_MATRIX), just the facts this app can read.
 */
export interface CameraFingerprint {
  facing?: 'back' | 'front';
  sourceWidth?: number;
  sourceHeight?: number;
  /** Normalised 0–1, rounded to reduce false positives from float noise. */
  zoom?: number;
}

export function cameraFingerprint(camera: CameraMetadata): CameraFingerprint {
  return {
    facing: camera.facing,
    sourceWidth: camera.sourceWidth,
    sourceHeight: camera.sourceHeight,
    zoom: camera.zoom !== undefined ? Math.round(camera.zoom * 100) / 100 : undefined,
  };
}

/**
 * True when two fingerprints describe a materially different camera setup —
 * a resolution or facing change, or a zoom drift past a small float-noise
 * tolerance. Used to decide whether a Site's saved metric calibration should
 * still be trusted (Phase 6/7): never silently reuse a transform built under
 * a different camera configuration.
 */
export function cameraConfigurationChanged(a: CameraFingerprint, b: CameraFingerprint): boolean {
  if (a.facing !== undefined && b.facing !== undefined && a.facing !== b.facing) return true;
  if (
    a.sourceWidth !== undefined &&
    b.sourceWidth !== undefined &&
    (a.sourceWidth !== b.sourceWidth || a.sourceHeight !== b.sourceHeight)
  ) {
    return true;
  }
  if (a.zoom !== undefined && b.zoom !== undefined && Math.abs(a.zoom - b.zoom) > 0.02) return true;
  return false;
}

/**
 * Future camera-intrinsics record (Phase 13). Nothing in this codebase
 * constructs one yet — expo-camera exposes no intrinsics or distortion data
 * to calibrate from, so a real profile can only come from a future
 * native-camera layer or an offline calibration procedure (e.g. a checkerboard
 * capture processed outside the app). Declared now so `CameraMetadata` and a
 * future SSIV homography stage have a stable shape to adopt, without forcing
 * anything to populate it from guessed device specifications.
 */
export interface CameraCalibrationProfile {
  id: string;
  deviceModel: string;
  cameraId: string;
  sourceWidth: number;
  sourceHeight: number;
  fx?: number;
  fy?: number;
  cx?: number;
  cy?: number;
  k1?: number;
  k2?: number;
  k3?: number;
  p1?: number;
  p2?: number;
  calibrationDate?: string;
  calibrationMethod?: string;
  calibrationRmsPx?: number;
}
