jest.mock('expo-sensors', () => ({
  Barometer: {
    isAvailableAsync: jest.fn(),
    addListener: jest.fn(),
  },
}));

import { Barometer } from 'expo-sensors';
import { capturePressureSnapshot } from '../../sensors/barometer';

function mockOf<T>(value: T): jest.Mock {
  return value as unknown as jest.Mock;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('capturePressureSnapshot', () => {
  it('resolves unavailable without subscribing when the sensor is absent', async () => {
    mockOf(Barometer.isAvailableAsync).mockResolvedValue(false);
    const result = await capturePressureSnapshot();
    expect(result).toEqual({ available: false });
    expect(Barometer.addListener).not.toHaveBeenCalled();
  });

  it('resolves with the real reading and cleans up its subscription', async () => {
    mockOf(Barometer.isAvailableAsync).mockResolvedValue(true);
    const remove = jest.fn();
    mockOf(Barometer.addListener).mockImplementation((listener: (reading: unknown) => void) => {
      // Real native listeners never fire synchronously inside the
      // registration call itself — deferring here matches that and avoids
      // calling back before the caller has stored its own subscription.
      queueMicrotask(() => listener({ pressure: 1013.2, timestamp: 0 }));
      return { remove };
    });

    const result = await capturePressureSnapshot();
    expect(result).toEqual({ available: true, atmosphericPressureHpa: 1013.2 });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('times out to unavailable instead of hanging when no reading ever arrives', async () => {
    mockOf(Barometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(Barometer.addListener).mockReturnValue({ remove: jest.fn() });

    const result = await capturePressureSnapshot(20);
    expect(result).toEqual({ available: false });
  });
});
