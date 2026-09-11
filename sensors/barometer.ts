import { Barometer } from 'expo-sensors';

import type { PressureSnapshot } from '../domain/sensor-snapshot';

/**
 * One-shot barometer read. Environmental/context metadata only — see
 * domain/sensor-snapshot.ts's PressureSnapshot doc: this is never used to
 * derive water pressure, flow, or Manning slope.
 */
export function capturePressureSnapshot(sampleWindowMs = 300): Promise<PressureSnapshot> {
  return Barometer.isAvailableAsync()
    .catch(() => false)
    .then((available) => {
      if (!available) return { available: false };

      return new Promise<PressureSnapshot>((resolve) => {
        let settled = false;
        let subscription: { remove: () => void } | null = null;

        const finish = (pressureHpa?: number) => {
          if (settled) return;
          settled = true;
          try {
            subscription?.remove();
          } catch {
            // Already gone.
          }
          resolve(
            pressureHpa !== undefined && Number.isFinite(pressureHpa)
              ? { available: true, atmosphericPressureHpa: pressureHpa }
              : { available: false }
          );
        };

        try {
          subscription = Barometer.addListener((reading) => finish(reading.pressure));
        } catch {
          finish(undefined);
          return;
        }
        setTimeout(() => finish(undefined), sampleWindowMs);
      });
    });
}
