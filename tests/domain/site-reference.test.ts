import {
  alignWithSiteReference,
  buildSiteCameraReference,
  cameraChangedFromReference,
} from '../../domain/site-reference';
import type { CameraMetadata, SensorSnapshot } from '../../domain/sensor-snapshot';

function fakeSnapshot(overrides: Partial<SensorSnapshot> = {}): SensorSnapshot {
  return {
    timestamp: Date.now(),
    device: { appVersion: '1.0.1', algorithmVersion: 'ssiv-1.0.0' },
    camera: { available: true, facing: 'back', sourceWidth: 1280, sourceHeight: 720, zoom: 0, intrinsicsAvailable: false, distortionAvailable: false },
    motion: { accelerometerAvailable: true, gyroscopeAvailable: true, deviceMotionAvailable: true, pitchDeg: 30, rollDeg: 1 },
    ...overrides,
  };
}

describe('buildSiteCameraReference', () => {
  it('carries pitch, roll and the camera fingerprint from the snapshot', () => {
    const reference = buildSiteCameraReference(fakeSnapshot());
    expect(reference.pitchDeg).toBe(30);
    expect(reference.rollDeg).toBe(1);
    expect(reference.cameraFingerprint).toEqual({ facing: 'back', sourceWidth: 1280, sourceHeight: 720, zoom: 0 });
    expect(reference.savedAt).toBeTruthy();
  });

  it('never stores a heading unless it was captured at GOOD quality', () => {
    const questionable = buildSiteCameraReference(
      fakeSnapshot({ magnetic: { available: true, headingDeg: 42, quality: 'QUESTIONABLE' } })
    );
    expect(questionable.headingDeg).toBeUndefined();

    const good = buildSiteCameraReference(
      fakeSnapshot({ magnetic: { available: true, headingDeg: 42, quality: 'GOOD' } })
    );
    expect(good.headingDeg).toBe(42);
  });

  it('stores the ROI when one is passed', () => {
    const roi = {
      topLeft: { x: 0.3, y: 0.2 },
      topRight: { x: 0.7, y: 0.2 },
      bottomRight: { x: 0.7, y: 0.8 },
      bottomLeft: { x: 0.3, y: 0.8 },
    };
    const reference = buildSiteCameraReference(fakeSnapshot(), roi);
    expect(reference.waterRoi).toEqual(roi);
  });
});

describe('alignWithSiteReference', () => {
  it('compares the current pose against the saved reference', () => {
    const reference = buildSiteCameraReference(fakeSnapshot());
    const alignment = alignWithSiteReference({ pitchDeg: 31, rollDeg: 4 }, reference);
    expect(alignment?.pitch?.band).toBe('GOOD');
    expect(alignment?.roll?.band).toBe('ACCEPTABLE');
  });

  it('returns null rather than comparing against a guessed 0° when the reference has no pitch/roll', () => {
    const alignment = alignWithSiteReference({ pitchDeg: 30, rollDeg: 1 }, { savedAt: new Date().toISOString() });
    expect(alignment).toBeNull();
  });

  it('never blocks the comparison for a missing heading on either side', () => {
    const reference = buildSiteCameraReference(fakeSnapshot());
    const alignment = alignWithSiteReference({ pitchDeg: 30, rollDeg: 1 }, reference);
    expect(alignment?.heading).toBeUndefined();
    expect(alignment?.pitch).toBeDefined();
  });
});

describe('cameraChangedFromReference', () => {
  const camera: CameraMetadata = {
    available: true,
    facing: 'back',
    sourceWidth: 1280,
    sourceHeight: 720,
    zoom: 0,
    intrinsicsAvailable: false,
    distortionAvailable: false,
  };

  it('is false when nothing has changed', () => {
    const reference = buildSiteCameraReference(fakeSnapshot());
    expect(cameraChangedFromReference(camera, reference)).toBe(false);
  });

  it('is true when the camera resolution changed (e.g. a different lens)', () => {
    const reference = buildSiteCameraReference(fakeSnapshot());
    const changed: CameraMetadata = { ...camera, sourceWidth: 1920, sourceHeight: 1080 };
    expect(cameraChangedFromReference(changed, reference)).toBe(true);
  });

  it('is false when the Site reference never recorded a fingerprint', () => {
    expect(cameraChangedFromReference(camera, { savedAt: new Date().toISOString() })).toBe(false);
  });
});
