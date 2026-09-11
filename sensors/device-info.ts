import * as Device from 'expo-device';
import Constants from 'expo-constants';

import { ALGORITHM_VERSION } from '../domain/types';
import type { DeviceInfo } from '../domain/sensor-snapshot';

/**
 * Device identity, read from expo-device's synchronous constants — no
 * permission, no async call, no possibility of a stale or guessed value: it
 * is either what the platform reports or absent.
 */
export function captureDeviceInfo(): DeviceInfo {
  return {
    ...(Device.manufacturer ? { manufacturer: Device.manufacturer } : {}),
    ...(Device.modelName ? { model: Device.modelName } : {}),
    ...(Device.osVersion ? { androidVersion: Device.osVersion } : {}),
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    algorithmVersion: ALGORITHM_VERSION,
  };
}
