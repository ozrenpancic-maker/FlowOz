import { Magnetometer } from 'expo-sensors';

import { estimateHeading, type MagneticSnapshot, type Vector3 } from '../domain/sensor-snapshot';

/**
 * One-shot magnetometer read. Never blocks a measurement: any failure —
 * sensor absent, a subscribe error, or simply no reading inside the sample
 * window — resolves to an honest UNAVAILABLE/QUESTIONABLE result rather than
 * throwing or hanging the caller.
 */
export function captureMagneticSnapshot(sampleWindowMs = 300): Promise<MagneticSnapshot> {
  return Magnetometer.isAvailableAsync()
    .catch(() => false)
    .then((available) => {
      if (!available) return { available: false, quality: 'UNAVAILABLE' as const };

      return new Promise<MagneticSnapshot>((resolve) => {
        let settled = false;
        let subscription: { remove: () => void } | null = null;

        const finish = (reading?: Vector3) => {
          if (settled) return;
          settled = true;
          try {
            subscription?.remove();
          } catch {
            // Already gone.
          }
          const { headingDeg, quality } = estimateHeading(reading);
          resolve({ available: true, quality, ...(headingDeg !== undefined ? { headingDeg } : {}) });
        };

        try {
          subscription = Magnetometer.addListener((reading) => finish(reading));
        } catch {
          finish(undefined);
          return;
        }
        setTimeout(() => finish(undefined), sampleWindowMs);
      });
    });
}
