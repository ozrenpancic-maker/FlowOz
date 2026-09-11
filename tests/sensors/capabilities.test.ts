jest.mock('expo-sensors', () => ({
  Accelerometer: { isAvailableAsync: jest.fn() },
  Gyroscope: { isAvailableAsync: jest.fn() },
  DeviceMotion: { isAvailableAsync: jest.fn() },
  Magnetometer: { isAvailableAsync: jest.fn() },
  Barometer: { isAvailableAsync: jest.fn() },
}));
jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: jest.fn(),
}));

import { Accelerometer, Barometer, DeviceMotion, Gyroscope, Magnetometer } from 'expo-sensors';
import * as Location from 'expo-location';
import { probeDeviceCapabilities } from '../../sensors/capabilities';

function mockOf<T>(value: T): jest.Mock {
  return value as unknown as jest.Mock;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('probeDeviceCapabilities', () => {
  it('reports each sensor exactly as isAvailableAsync says', async () => {
    mockOf(Accelerometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(Gyroscope.isAvailableAsync).mockResolvedValue(true);
    mockOf(DeviceMotion.isAvailableAsync).mockResolvedValue(false);
    mockOf(Magnetometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(Barometer.isAvailableAsync).mockResolvedValue(false);
    mockOf(Location.hasServicesEnabledAsync).mockResolvedValue(false);

    const result = await probeDeviceCapabilities();
    expect(result).toEqual({
      accelerometer: true,
      gyroscope: true,
      deviceMotion: false,
      magnetometer: true,
      barometer: false,
      gpsServicesEnabled: false,
      arcoreSupported: 'UNKNOWN',
      depthSupported: 'UNKNOWN',
      tofAccessible: 'UNKNOWN',
    });
  });

  it('degrades a single failing probe to false instead of rejecting the whole screen', async () => {
    mockOf(Accelerometer.isAvailableAsync).mockRejectedValue(new Error('native module crashed'));
    mockOf(Gyroscope.isAvailableAsync).mockResolvedValue(true);
    mockOf(DeviceMotion.isAvailableAsync).mockResolvedValue(true);
    mockOf(Magnetometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(Barometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(Location.hasServicesEnabledAsync).mockRejectedValue(new Error('permission denied'));

    const result = await probeDeviceCapabilities();
    expect(result.accelerometer).toBe(false);
    expect(result.gpsServicesEnabled).toBe(false);
    // The other, unrelated probes are unaffected.
    expect(result.gyroscope).toBe(true);
    expect(result.deviceMotion).toBe(true);
  });
});
