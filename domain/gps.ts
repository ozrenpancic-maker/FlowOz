import type { GeoLocation } from './types';

/** GPS accuracy classes (specification §16). */
export type GpsAccuracyClass = 'GOOD' | 'ACCEPTABLE' | 'POOR' | 'UNKNOWN';

export const GPS_GOOD_THRESHOLD_M = 5;
export const GPS_ACCEPTABLE_THRESHOLD_M = 15;

export function classifyAccuracy(accuracyM: number | undefined | null): GpsAccuracyClass {
  if (accuracyM === undefined || accuracyM === null || !Number.isFinite(accuracyM) || accuracyM < 0) {
    return 'UNKNOWN';
  }
  if (accuracyM <= GPS_GOOD_THRESHOLD_M) return 'GOOD';
  if (accuracyM <= GPS_ACCEPTABLE_THRESHOLD_M) return 'ACCEPTABLE';
  return 'POOR';
}

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius

/** Great-circle distance between two fixes [m]. */
export function haversineDistance(
  a: Pick<GeoLocation, 'latitude' | 'longitude'>,
  b: Pick<GeoLocation, 'latitude' | 'longitude'>
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const dLat = lat2 - lat1;
  const dLon = toRadians(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface SiteDistanceCheck {
  distanceM: number;
  /** True when the measurement is further from the site than the threshold. */
  exceedsThreshold: boolean;
  thresholdM: number;
}

/**
 * Compare a measurement fix with the site's stored location. A mismatch is a
 * warning, never a block — the operator may legitimately be measuring at a
 * different point of the same structure.
 */
export function compareWithSite(
  measurement: Pick<GeoLocation, 'latitude' | 'longitude'>,
  site: Pick<GeoLocation, 'latitude' | 'longitude'>,
  thresholdM: number
): SiteDistanceCheck {
  const distanceM = haversineDistance(measurement, site);
  return {
    distanceM,
    exceedsThreshold: Number.isFinite(distanceM) && distanceM > thresholdM,
    thresholdM,
  };
}
