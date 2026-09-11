jest.mock('expo-sensors', () => ({
  Magnetometer: {
    isAvailableAsync: jest.fn(),
    addListener: jest.fn(),
  },
}));

import { Magnetometer } from 'expo-sensors';
import { captureMagneticSnapshot } from '../../sensors/magnetometer';

function mockOf<T>(value: T): jest.Mock {
  return value as unknown as jest.Mock;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('captureMagneticSnapshot', () => {
  it('resolves UNAVAILABLE without subscribing when the sensor is absent', async () => {
    mockOf(Magnetometer.isAvailableAsync).mockResolvedValue(false);
    const result = await captureMagneticSnapshot();
    expect(result).toEqual({ available: false, quality: 'UNAVAILABLE' });
    expect(Magnetometer.addListener).not.toHaveBeenCalled();
  });

  it('resolves with a real heading and removes its subscription once a reading arrives', async () => {
    mockOf(Magnetometer.isAvailableAsync).mockResolvedValue(true);
    const remove = jest.fn();
    mockOf(Magnetometer.addListener).mockImplementation((listener: (reading: unknown) => void) => {
      // Real native listeners never fire synchronously inside the
      // registration call itself — deferring here matches that and avoids
      // calling back before the caller has stored its own subscription.
      queueMicrotask(() => listener({ x: 1, y: 0, z: 0, timestamp: 0 }));
      return { remove };
    });

    const result = await captureMagneticSnapshot();
    expect(result.available).toBe(true);
    expect(result.quality).toBe('QUESTIONABLE');
    expect(result.headingDeg).toBeCloseTo(0, 6);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('times out to an honest UNAVAILABLE result instead of hanging when no reading ever arrives', async () => {
    mockOf(Magnetometer.isAvailableAsync).mockResolvedValue(true);
    const remove = jest.fn();
    mockOf(Magnetometer.addListener).mockReturnValue({ remove });

    const result = await captureMagneticSnapshot(20);
    expect(result.available).toBe(true);
    expect(result.quality).toBe('UNAVAILABLE');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('never throws out of the caller when addListener itself throws', async () => {
    mockOf(Magnetometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(Magnetometer.addListener).mockImplementation(() => {
      throw new Error('native module unavailable');
    });

    await expect(captureMagneticSnapshot()).resolves.toEqual({ available: true, quality: 'UNAVAILABLE' });
  });
});
