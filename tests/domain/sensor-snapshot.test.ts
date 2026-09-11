import {
  cameraConfigurationChanged,
  cameraFingerprint,
  classifyStability,
  compareOrientation,
  estimateHeading,
  rms,
  STANDARD_GRAVITY_MPS2,
  summarizeMotion,
  type CameraMetadata,
  type RawMotionSamples,
} from '../../domain/sensor-snapshot';

function fakeCamera(overrides: Partial<CameraMetadata> = {}): CameraMetadata {
  return {
    available: true,
    intrinsicsAvailable: false,
    distortionAvailable: false,
    ...overrides,
  };
}

describe('rms', () => {
  it('computes the root-mean-square of a sample array', () => {
    expect(rms([3, 4])).toBeCloseTo(Math.sqrt((9 + 16) / 2), 9);
    expect(rms([0, 0, 0])).toBe(0);
  });

  it('returns NaN for no samples rather than a false zero', () => {
    expect(Number.isNaN(rms([]))).toBe(true);
  });
});

describe('classifyStability', () => {
  it('is GOOD when both RMS figures sit under the good threshold', () => {
    expect(classifyStability(0.2, 0.1)).toBe('GOOD');
  });

  it('is ACCEPTABLE when either figure is only in the acceptable band', () => {
    expect(classifyStability(1.0, 0.1)).toBe('ACCEPTABLE');
    expect(classifyStability(0.2, 0.6)).toBe('ACCEPTABLE');
  });

  it('is POOR when either figure exceeds the acceptable band', () => {
    expect(classifyStability(3, 0.1)).toBe('POOR');
    expect(classifyStability(0.2, 2)).toBe('POOR');
  });

  it('is UNKNOWN, not a fabricated GOOD, when no motion data exists at all', () => {
    expect(classifyStability(undefined, undefined)).toBe('UNKNOWN');
  });

  it('grades on whichever single figure is actually available', () => {
    expect(classifyStability(3, undefined)).toBe('POOR');
    expect(classifyStability(undefined, 0.1)).toBe('GOOD');
  });
});

describe('compareOrientation', () => {
  it('grades pitch and roll independently against the reference', () => {
    const alignment = compareOrientation(
      { pitchDeg: 31, rollDeg: 4 },
      { pitchDeg: 30, rollDeg: 1 }
    );
    expect(alignment.pitch?.deltaDeg).toBeCloseTo(1, 9);
    expect(alignment.pitch?.band).toBe('GOOD');
    expect(alignment.roll?.deltaDeg).toBeCloseTo(3, 9);
    expect(alignment.roll?.band).toBe('ACCEPTABLE');
  });

  it('never compares heading when either side lacks one, and never blocks pitch/roll', () => {
    const alignment = compareOrientation({ pitchDeg: 30, rollDeg: 1 }, { pitchDeg: 30, rollDeg: 1 });
    expect(alignment.heading).toBeUndefined();
    expect(alignment.pitch?.band).toBe('GOOD');
    expect(alignment.roll?.band).toBe('GOOD');
  });

  it('takes the shortest signed angular difference across the compass wraparound', () => {
    const alignment = compareOrientation(
      { pitchDeg: 0, rollDeg: 0, headingDeg: 5 },
      { pitchDeg: 0, rollDeg: 0, headingDeg: 355 }
    );
    // 5 - 355 = -350, which wraps to +10, not a huge 350° swing.
    expect(alignment.heading?.deltaDeg).toBeCloseTo(10, 6);
    expect(alignment.heading?.band).toBe('GOOD');
  });
});

describe('summarizeMotion', () => {
  const baseAvailability = {
    accelerometerAvailable: true,
    gyroscopeAvailable: true,
    deviceMotionAvailable: true,
  };

  it('reports no readings at all as unavailable, not as fabricated zeros', () => {
    const summary = summarizeMotion({
      accelerometerAvailable: false,
      gyroscopeAvailable: false,
      deviceMotionAvailable: false,
      gravitySamples: [],
      angularSpeedsDegPerSec: [],
      linearAccelSamplesMps2: [],
    });
    expect(summary.pitchDeg).toBeUndefined();
    expect(summary.rollDeg).toBeUndefined();
    expect(summary.angularVelocityRmsDegPerSec).toBeUndefined();
    expect(summary.accelerationRmsMps2).toBeUndefined();
    expect(summary.gravityVector).toBeUndefined();
    expect(summary.sampleCount).toBe(0);
  });

  it('derives pitch/roll from the accelerometer gravity vector by simple trigonometry', () => {
    const flat = summarizeMotion({
      ...baseAvailability,
      gravitySamples: [{ x: 0, y: 0, z: 1 }],
      angularSpeedsDegPerSec: [],
      linearAccelSamplesMps2: [],
    });
    expect(flat.pitchDeg).toBeCloseTo(0, 6);
    expect(flat.rollDeg).toBeCloseTo(0, 6);

    const rolled = summarizeMotion({
      ...baseAvailability,
      gravitySamples: [{ x: 0, y: 1, z: 0 }],
      angularSpeedsDegPerSec: [],
      linearAccelSamplesMps2: [],
    });
    expect(rolled.pitchDeg).toBeCloseTo(0, 6);
    expect(rolled.rollDeg).toBeCloseTo(90, 6);
  });

  it('computes angular velocity RMS from the sampled window, not one instantaneous reading', () => {
    const summary = summarizeMotion({
      ...baseAvailability,
      gravitySamples: [{ x: 0, y: 0, z: 1 }],
      angularSpeedsDegPerSec: [1, 2, 2, 3],
      linearAccelSamplesMps2: [],
    });
    expect(summary.angularVelocityRmsDegPerSec).toBeCloseTo(rms([1, 2, 2, 3]), 9);
  });

  it('prefers the DeviceMotion linear-acceleration channel when it is present', () => {
    const summary = summarizeMotion({
      ...baseAvailability,
      gravitySamples: [
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: 1 },
      ],
      angularSpeedsDegPerSec: [],
      linearAccelSamplesMps2: [
        { x: 0.1, y: 0, z: 0 },
        { x: 0.3, y: 0, z: 0 },
      ],
    });
    expect(summary.accelerationRmsMps2).toBeCloseTo(rms([0.1, 0.3]), 9);
  });

  it('falls back to a mean-removed, gravity-converted accelerometer reading when there is no linear-acceleration channel', () => {
    const summary = summarizeMotion({
      ...baseAvailability,
      gravitySamples: [
        { x: 0, y: 0, z: 1 },
        { x: 0.01, y: 0, z: 1 },
        { x: -0.01, y: 0, z: 1 },
      ],
      angularSpeedsDegPerSec: [],
      linearAccelSamplesMps2: [],
    });
    // Mean-removing a near-constant ~1g signal should leave only the tiny
    // wobble, scaled into m/s^2 — nowhere near the ~9.8 m/s^2 raw gravity
    // magnitude, which would indicate the offset was never actually removed.
    // Deviations from the mean are [0, 0.01, -0.01] on x, so the expected
    // value is rms([0, 0.01, 0.01]) scaled by g, not a hand-typed constant.
    expect(summary.accelerationRmsMps2).toBeDefined();
    expect(summary.accelerationRmsMps2 as number).toBeLessThan(1);
    expect(summary.accelerationRmsMps2 as number).toBeGreaterThan(0);
    expect(summary.accelerationRmsMps2 as number).toBeCloseTo(rms([0, 0.01, 0.01]) * STANDARD_GRAVITY_MPS2, 9);
  });

  it('never computes an acceleration fallback from a single sample (no variance is measurable)', () => {
    const summary = summarizeMotion({
      ...baseAvailability,
      gravitySamples: [{ x: 0, y: 0, z: 1 }],
      angularSpeedsDegPerSec: [],
      linearAccelSamplesMps2: [],
    });
    expect(summary.accelerationRmsMps2).toBeUndefined();
    // But pitch/roll are still reported from that one sample.
    expect(summary.pitchDeg).toBeCloseTo(0, 6);
  });

  it('carries the availability flags and sample count through untouched', () => {
    const raw: RawMotionSamples = {
      accelerometerAvailable: true,
      gyroscopeAvailable: false,
      deviceMotionAvailable: true,
      gravitySamples: [
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z: 1 },
      ],
      angularSpeedsDegPerSec: [],
      linearAccelSamplesMps2: [],
      windowDurationS: 5.2,
    };
    const summary = summarizeMotion(raw);
    expect(summary.accelerometerAvailable).toBe(true);
    expect(summary.gyroscopeAvailable).toBe(false);
    expect(summary.deviceMotionAvailable).toBe(true);
    expect(summary.sampleCount).toBe(2);
    expect(summary.windowDurationS).toBe(5.2);
  });
});

describe('estimateHeading', () => {
  it('reports UNAVAILABLE with no reading', () => {
    expect(estimateHeading(undefined)).toEqual({ quality: 'UNAVAILABLE' });
  });

  it('computes a real angle from a real reading, but never claims GOOD confidence', () => {
    const { headingDeg, quality } = estimateHeading({ x: 1, y: 0, z: 0 });
    expect(headingDeg).toBeCloseTo(0, 6);
    expect(quality).toBe('QUESTIONABLE');
  });

  it('always reports QUESTIONABLE even for an otherwise clean reading — never GOOD', () => {
    const { quality } = estimateHeading({ x: 0, y: 1, z: 0 });
    expect(quality).toBe('QUESTIONABLE');
  });
});

describe('camera fingerprint / configuration change', () => {
  it('is unchanged when facing, resolution and zoom all match', () => {
    const a = cameraFingerprint(fakeCamera({ facing: 'back', sourceWidth: 1280, sourceHeight: 720, zoom: 0 }));
    const b = cameraFingerprint(fakeCamera({ facing: 'back', sourceWidth: 1280, sourceHeight: 720, zoom: 0.001 }));
    expect(cameraConfigurationChanged(a, b)).toBe(false);
  });

  it('flags a facing change', () => {
    const a = cameraFingerprint(fakeCamera({ facing: 'back' }));
    const b = cameraFingerprint(fakeCamera({ facing: 'front' }));
    expect(cameraConfigurationChanged(a, b)).toBe(true);
  });

  it('flags a resolution change (e.g. a different physical lens)', () => {
    const a = cameraFingerprint(fakeCamera({ sourceWidth: 1280, sourceHeight: 720 }));
    const b = cameraFingerprint(fakeCamera({ sourceWidth: 1920, sourceHeight: 1080 }));
    expect(cameraConfigurationChanged(a, b)).toBe(true);
  });

  it('flags a real zoom change but tolerates float noise', () => {
    const a = cameraFingerprint(fakeCamera({ zoom: 0 }));
    const tiny = cameraFingerprint(fakeCamera({ zoom: 0.001 }));
    const real = cameraFingerprint(fakeCamera({ zoom: 0.3 }));
    expect(cameraConfigurationChanged(a, tiny)).toBe(false);
    expect(cameraConfigurationChanged(a, real)).toBe(true);
  });

  it('never flags a change when one side never reported a value', () => {
    const a = cameraFingerprint(fakeCamera({}));
    const b = cameraFingerprint(fakeCamera({ facing: 'back', sourceWidth: 1280, sourceHeight: 720, zoom: 0.5 }));
    expect(cameraConfigurationChanged(a, b)).toBe(false);
  });
});
