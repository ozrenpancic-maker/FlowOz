import {
  cameraConfigurationChanged,
  cameraFingerprint,
  compareOrientation,
  type CameraMetadata,
  type OrientationAlignment,
  type SensorSnapshot,
} from './sensor-snapshot';
import type { SiteCameraReference, WaterRoi } from './types';

/**
 * Site-level camera repeatability (Phase 3/6/7): a saved reference pose the
 * operator can re-aim the camera against on a later visit, and a fingerprint
 * that flags when the camera setup itself has changed since a Site's metric
 * calibration was built. Neither of these is a calibration on its own — they
 * exist to protect one.
 */

/** Build a Site's saved reference from a completed measurement's snapshot. */
export function buildSiteCameraReference(snapshot: SensorSnapshot, waterRoi?: WaterRoi): SiteCameraReference {
  return {
    ...(snapshot.motion.pitchDeg !== undefined ? { pitchDeg: snapshot.motion.pitchDeg } : {}),
    ...(snapshot.motion.rollDeg !== undefined ? { rollDeg: snapshot.motion.rollDeg } : {}),
    // Only ever set when the heading was captured at a quality this app
    // actually trusts — see estimateHeading's own doc comment for why that is
    // never GOOD in the current implementation.
    ...(snapshot.magnetic?.quality === 'GOOD' && snapshot.magnetic.headingDeg !== undefined
      ? { headingDeg: snapshot.magnetic.headingDeg }
      : {}),
    cameraFingerprint: cameraFingerprint(snapshot.camera),
    ...(waterRoi ? { waterRoi } : {}),
    savedAt: new Date().toISOString(),
  };
}

/**
 * Compare the current camera pose with a Site's saved reference. Returns null
 * when the reference has no pitch/roll to compare against at all — never a
 * comparison built on a guessed 0°.
 */
export function alignWithSiteReference(
  current: { pitchDeg?: number; rollDeg?: number; headingDeg?: number },
  reference: SiteCameraReference
): OrientationAlignment | null {
  if (reference.pitchDeg === undefined || reference.rollDeg === undefined) return null;
  return compareOrientation(current, {
    pitchDeg: reference.pitchDeg,
    rollDeg: reference.rollDeg,
    ...(reference.headingDeg !== undefined ? { headingDeg: reference.headingDeg } : {}),
  });
}

/**
 * True when the camera actually in use no longer matches the Site's saved
 * reference closely enough to trust a calibration built under the old one
 * (Phase 6/7) — a lens switch, a resolution change, or zoom drift.
 */
export function cameraChangedFromReference(current: CameraMetadata, reference: SiteCameraReference): boolean {
  if (!reference.cameraFingerprint) return false;
  return cameraConfigurationChanged(cameraFingerprint(current), reference.cameraFingerprint);
}
