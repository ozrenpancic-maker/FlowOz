import * as Location from 'expo-location';

import type { GeoLocation } from '../domain/types';

/**
 * Foreground GPS capture.
 *
 * Only ever called from an explicit operator action or when "capture GPS with
 * measurements" is enabled. A denied permission or a failed fix is returned as
 * a reason, never thrown: a measurement must still be savable without GPS.
 */
export type GpsCaptureResult =
  | { ok: true; location: GeoLocation }
  | { ok: false; reasonKey: string; detail?: string };

export async function captureGps(): Promise<GpsCaptureResult> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      return { ok: false, reasonKey: 'gps.permissionDenied' };
    }

    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return {
      ok: true,
      location: {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        ...(position.coords.accuracy !== null && position.coords.accuracy !== undefined
          ? { accuracy: position.coords.accuracy }
          : {}),
        ...(position.coords.altitude !== null && position.coords.altitude !== undefined
          ? { altitude: position.coords.altitude }
          : {}),
        timestamp: position.timestamp,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reasonKey: 'gps.permissionDenied',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
