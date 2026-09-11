import { Accelerometer, DeviceMotion, Gyroscope } from 'expo-sensors';

import { summarizeMotion, type MotionSummary, type RawMotionSamples, type Vector3 } from '../domain/sensor-snapshot';

/**
 * Native-touching half of camera-stability capture. Everything that decides
 * *what the numbers mean* (RMS, pitch/roll trigonometry, the fallback when a
 * channel is missing) lives in `domain/sensor-snapshot.ts`'s `summarizeMotion`
 * and is unit-tested there; this class only collects raw readings for the
 * duration of one acquisition window and hands them over.
 *
 * Every listener and the availability probe is wrapped so a sensor hiccup on
 * an unusual device degrades to "unavailable" rather than throwing out of a
 * native event callback into the middle of a video recording.
 */
export class MotionSampler {
  private gravitySamples: Vector3[] = [];
  private angularSpeedsDegPerSec: number[] = [];
  private linearAccelSamplesMps2: Vector3[] = [];
  private subscriptions: { remove: () => void }[] = [];
  private startedAtMs = 0;
  private running = false;

  private accelerometerAvailable = false;
  private gyroscopeAvailable = false;
  private deviceMotionAvailable = false;

  /** Begin sampling. Safe to call once per instance; call stop() to end and
   * read the summary, even if start() never resolved a usable sensor. */
  async start(sampleIntervalMs = 100): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.gravitySamples = [];
    this.angularSpeedsDegPerSec = [];
    this.linearAccelSamplesMps2 = [];
    this.startedAtMs = Date.now();

    const [accelAvail, gyroAvail, dmAvail] = await Promise.all([
      Accelerometer.isAvailableAsync().catch(() => false),
      Gyroscope.isAvailableAsync().catch(() => false),
      DeviceMotion.isAvailableAsync().catch(() => false),
    ]);

    // stop() may already have been called while these checks were pending.
    if (!this.running) return;

    this.accelerometerAvailable = accelAvail;
    this.gyroscopeAvailable = gyroAvail;
    this.deviceMotionAvailable = dmAvail;

    try {
      Accelerometer.setUpdateInterval(sampleIntervalMs);
      Gyroscope.setUpdateInterval(sampleIntervalMs);
      DeviceMotion.setUpdateInterval(sampleIntervalMs);
    } catch {
      // Some platforms reject an interval they don't support; sampling still
      // proceeds at whatever default rate the platform provides.
    }

    if (accelAvail) {
      this.subscribe(() =>
        Accelerometer.addListener((reading) => {
          this.gravitySamples.push({ x: reading.x, y: reading.y, z: reading.z });
        })
      );
    }

    if (dmAvail) {
      this.subscribe(() =>
        DeviceMotion.addListener((reading) => {
          if (reading.rotationRate) {
            const { alpha, beta, gamma } = reading.rotationRate;
            this.angularSpeedsDegPerSec.push(Math.hypot(alpha, beta, gamma));
          }
          if (reading.acceleration) {
            this.linearAccelSamplesMps2.push(reading.acceleration);
          }
        })
      );
    } else if (gyroAvail) {
      // Fallback: Gyroscope reports rad/s; convert to deg/s to match
      // DeviceMotion.rotationRate's documented unit.
      this.subscribe(() =>
        Gyroscope.addListener((reading) => {
          this.angularSpeedsDegPerSec.push(Math.hypot(reading.x, reading.y, reading.z) * (180 / Math.PI));
        })
      );
    }
  }

  private subscribe(register: () => { remove: () => void }): void {
    try {
      this.subscriptions.push(register());
    } catch {
      // A sensor that reported itself available but fails to subscribe is
      // treated the same as one that was never available for this window.
    }
  }

  /** Stop sampling, release every subscription, and return the summary. Safe
   * to call even if start() never ran or every sensor was unavailable. */
  stop(): MotionSummary {
    this.running = false;
    for (const subscription of this.subscriptions) {
      try {
        subscription.remove();
      } catch {
        // Already gone — nothing further to release.
      }
    }
    this.subscriptions = [];

    const raw: RawMotionSamples = {
      accelerometerAvailable: this.accelerometerAvailable,
      gyroscopeAvailable: this.gyroscopeAvailable,
      deviceMotionAvailable: this.deviceMotionAvailable,
      gravitySamples: this.gravitySamples,
      angularSpeedsDegPerSec: this.angularSpeedsDegPerSec,
      linearAccelSamplesMps2: this.linearAccelSamplesMps2,
      ...(this.startedAtMs > 0 ? { windowDurationS: (Date.now() - this.startedAtMs) / 1000 } : {}),
    };
    return summarizeMotion(raw);
  }
}
