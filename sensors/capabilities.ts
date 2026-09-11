import { Accelerometer, Barometer, DeviceMotion, Gyroscope, Magnetometer } from 'expo-sensors';
import * as Location from 'expo-location';

import type { Tri } from '../domain/sensor-snapshot';

export interface DeviceCapabilities {
  accelerometer: boolean;
  gyroscope: boolean;
  deviceMotion: boolean;
  magnetometer: boolean;
  barometer: boolean;
  /** Location services enabled at the OS level — this checks the system
   * setting, not app permission, so it needs no permission prompt. */
  gpsServicesEnabled: boolean;
  /** No native ARCore/depth probe is wired up (see DepthCapabilitySnapshot's
   * doc comment) — always UNKNOWN until a future native layer exists. */
  arcoreSupported: Tri;
  depthSupported: Tri;
  tofAccessible: Tri;
}

/**
 * Live capability probe for the Device Capabilities diagnostic screen
 * (Settings → Engineering). Every boolean here is a real isAvailableAsync (or
 * equivalent) call — never a static guess — and every call is individually
 * guarded so one sensor's failure cannot blank the rest of the screen.
 */
export async function probeDeviceCapabilities(): Promise<DeviceCapabilities> {
  const [accelerometer, gyroscope, deviceMotion, magnetometer, barometer, gpsServicesEnabled] =
    await Promise.all([
      Accelerometer.isAvailableAsync().catch(() => false),
      Gyroscope.isAvailableAsync().catch(() => false),
      DeviceMotion.isAvailableAsync().catch(() => false),
      Magnetometer.isAvailableAsync().catch(() => false),
      Barometer.isAvailableAsync().catch(() => false),
      Location.hasServicesEnabledAsync().catch(() => false),
    ]);

  return {
    accelerometer,
    gyroscope,
    deviceMotion,
    magnetometer,
    barometer,
    gpsServicesEnabled,
    arcoreSupported: 'UNKNOWN',
    depthSupported: 'UNKNOWN',
    tofAccessible: 'UNKNOWN',
  };
}
