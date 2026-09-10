import { activeAlpha } from './calibration';
import type { SavedMeasurement } from './measurement';
import type { Dimensions, MeasurementDraft, Site } from './types';
import { DEFAULT_ALPHA } from './types';

/**
 * Draft construction.
 *
 * A draft is transient working state; nothing here is a record until it is
 * written through the repository. These are pure functions, deliberately kept
 * out of the React context so they can be tested on their own.
 */

export function emptyDimensions(kind: Dimensions['kind']): Dimensions {
  switch (kind) {
    case 'circular':
      return { kind: 'circular', diameter: 0.3 };
    case 'rectangular':
      return { kind: 'rectangular', width: 0.5 };
    case 'trapezoidal':
      return {
        kind: 'trapezoidal',
        bottomWidth: 0.5,
        leftSlope: { mode: 'ratio', value: 1 },
        rightSlope: { mode: 'ratio', value: 1 },
      };
  }
}

export function emptyDraft(defaultAlpha = DEFAULT_ALPHA): MeasurementDraft {
  return {
    geometry: 'circular',
    dimensions: emptyDimensions('circular'),
    unit: 'mm',
    depth: null,
    levelMethod: 'manual',
    method: 'video',
    roughness: 0.013,
    slopePermille: null,
    manualVelocity: null,
    alpha: defaultAlpha,
    alphaProvenance: 'ASSUMED',
  };
}

export function draftFromSite(site: Site): MeasurementDraft {
  const alpha = activeAlpha(site.calibrationPoints);
  return {
    ...site.draft,
    siteId: site.id,
    siteName: site.name,
    // Depth is never inherited: it is measured again every time.
    depth: null,
    surfaceVelocity: undefined,
    videoUri: undefined,
    videoDuration: undefined,
    videoSource: undefined,
    videoCapturedAt: undefined,
    waterRoi: undefined,
    knownRoiDimensions: undefined,
    photoUri: undefined,
    alpha: alpha.alpha,
    alphaProvenance: alpha.status === 'calibrated' ? 'CALIBRATED' : 'ASSUMED',
    ...(site.location ? { location: site.location } : {}),
  };
}

/**
 * Build a retry draft from a saved measurement.
 *
 * Site, geometry, depth, the original stored video, the ROI and the physical
 * scale all survive. Only the transient previous result — the surface velocity
 * and its analysis — is cleared, so the retry recomputes rather than inheriting.
 */
export function retryDraftFrom(measurement: SavedMeasurement): MeasurementDraft {
  const stored = measurement.raw.draft;
  return {
    ...stored,
    ...(measurement.siteId ? { siteId: measurement.siteId } : {}),
    ...(measurement.siteName ? { siteName: measurement.siteName } : {}),
    geometry: measurement.geometry,
    dimensions: measurement.dimensions,
    depth: measurement.depth,
    unit: measurement.unit,
    levelMethod: measurement.levelMethod,
    method: 'video',
    ...(measurement.videoUri ? { videoUri: measurement.videoUri } : {}),
    ...(measurement.videoDuration !== undefined ? { videoDuration: measurement.videoDuration } : {}),
    ...(measurement.videoSource ? { videoSource: measurement.videoSource } : {}),
    ...(measurement.videoCapturedAt ? { videoCapturedAt: measurement.videoCapturedAt } : {}),
    ...(measurement.waterRoi ? { waterRoi: measurement.waterRoi } : {}),
    ...(measurement.perspectiveScale ? { knownRoiDimensions: measurement.perspectiveScale } : {}),
    alpha: measurement.alpha ?? stored.alpha,
    alphaProvenance: measurement.provenance.alpha,
    // Cleared: this is what the retry is going to recompute.
    surfaceVelocity: undefined,
  };
}
