jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { High: 4 },
}));

import * as Location from 'expo-location';
import { captureGps } from '../../state/gps-capture';

function mockOf<T>(value: T): jest.Mock {
  return value as unknown as jest.Mock;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('captureGps', () => {
  it('returns a typed failure, not a thrown error, when the permission is denied', async () => {
    mockOf(Location.requestForegroundPermissionsAsync).mockResolvedValue({ granted: false });
    const result = await captureGps();
    expect(result).toEqual({ ok: false, reasonKey: 'gps.permissionDenied' });
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('returns a typed failure rather than throwing when the platform call itself rejects', async () => {
    mockOf(Location.requestForegroundPermissionsAsync).mockRejectedValue(new Error('location services disabled'));
    const result = await captureGps();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonKey).toBe('gps.permissionDenied');
      expect(result.detail).toContain('location services disabled');
    }
  });

  it('returns only the fields the platform actually reported, never a guessed accuracy or altitude', async () => {
    mockOf(Location.requestForegroundPermissionsAsync).mockResolvedValue({ granted: true });
    mockOf(Location.getCurrentPositionAsync).mockResolvedValue({
      coords: { latitude: 45.8, longitude: 16.0, accuracy: null, altitude: null },
      timestamp: 1_700_000_000_000,
    });
    const result = await captureGps();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.location.latitude).toBe(45.8);
      expect(result.location.longitude).toBe(16.0);
      expect(result.location.accuracy).toBeUndefined();
      expect(result.location.altitude).toBeUndefined();
    }
  });

  it('carries a real accuracy and altitude through when the platform reports them', async () => {
    mockOf(Location.requestForegroundPermissionsAsync).mockResolvedValue({ granted: true });
    mockOf(Location.getCurrentPositionAsync).mockResolvedValue({
      coords: { latitude: 45.8, longitude: 16.0, accuracy: 4.2, altitude: 120.5 },
      timestamp: 1_700_000_000_000,
    });
    const result = await captureGps();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.location.accuracy).toBe(4.2);
      expect(result.location.altitude).toBe(120.5);
    }
  });
});
