import {
  classifyAccuracy,
  compareWithSite,
  GPS_ACCEPTABLE_THRESHOLD_M,
  GPS_GOOD_THRESHOLD_M,
  haversineDistance,
} from '../../domain/gps';

describe('GPS accuracy classification', () => {
  it('applies the ≤5 m / ≤15 m thresholds', () => {
    expect(classifyAccuracy(0)).toBe('GOOD');
    expect(classifyAccuracy(GPS_GOOD_THRESHOLD_M)).toBe('GOOD');
    expect(classifyAccuracy(GPS_GOOD_THRESHOLD_M + 0.001)).toBe('ACCEPTABLE');
    expect(classifyAccuracy(GPS_ACCEPTABLE_THRESHOLD_M)).toBe('ACCEPTABLE');
    expect(classifyAccuracy(GPS_ACCEPTABLE_THRESHOLD_M + 0.001)).toBe('POOR');
  });

  it('says UNKNOWN rather than guessing when there is no accuracy figure', () => {
    expect(classifyAccuracy(undefined)).toBe('UNKNOWN');
    expect(classifyAccuracy(null)).toBe('UNKNOWN');
    expect(classifyAccuracy(Number.NaN)).toBe('UNKNOWN');
    expect(classifyAccuracy(-1)).toBe('UNKNOWN');
  });
});

describe('Haversine distance', () => {
  it('is zero for identical fixes', () => {
    const point = { latitude: 45.815, longitude: 15.9819 };
    expect(haversineDistance(point, point)).toBeCloseTo(0, 9);
  });

  it('matches a known one-degree separation on the equator', () => {
    // One degree of latitude ≈ 111.2 km on a spherical Earth.
    const distance = haversineDistance(
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 0 }
    );
    expect(distance).toBeGreaterThan(111_000);
    expect(distance).toBeLessThan(111_400);
  });

  it('matches a known city pair to within a kilometre', () => {
    // Zagreb → Split, about 259 km great-circle.
    const distance = haversineDistance(
      { latitude: 45.815, longitude: 15.9819 },
      { latitude: 43.5081, longitude: 16.4402 }
    );
    expect(distance / 1000).toBeGreaterThan(258.5);
    expect(distance / 1000).toBeLessThan(259.5);
  });

  it('is symmetric', () => {
    const a = { latitude: 45.1, longitude: 14.2 };
    const b = { latitude: 46.3, longitude: 16.7 };
    expect(haversineDistance(a, b)).toBeCloseTo(haversineDistance(b, a), 6);
  });

  it('handles a short baseline at field scale', () => {
    // 0.0001° of latitude is about 11 m.
    const distance = haversineDistance(
      { latitude: 45.815, longitude: 15.9819 },
      { latitude: 45.8151, longitude: 15.9819 }
    );
    expect(distance).toBeGreaterThan(10);
    expect(distance).toBeLessThan(12);
  });
});

describe('site distance check', () => {
  const site = { latitude: 45.815, longitude: 15.9819 };

  it('warns only above the configured threshold', () => {
    const near = compareWithSite({ latitude: 45.81505, longitude: 15.9819 }, site, 50);
    expect(near.exceedsThreshold).toBe(false);

    const far = compareWithSite({ latitude: 45.818, longitude: 15.9819 }, site, 50);
    expect(far.exceedsThreshold).toBe(true);
    expect(far.distanceM).toBeGreaterThan(50);
  });

  it('reports the threshold it used', () => {
    expect(compareWithSite(site, site, 37).thresholdM).toBe(37);
  });
});
