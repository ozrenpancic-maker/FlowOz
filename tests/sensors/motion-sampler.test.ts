/**
 * MotionSampler is the one piece of this feature that actually touches a
 * native module, so it is exercised here against a controllable fake
 * expo-sensors rather than left untested — the release checklist explicitly
 * calls for coverage of subscription cleanup and total-sensor-failure
 * behaviour, and both are real regressions a refactor could reintroduce.
 */
jest.mock('expo-sensors', () => {
  const makeMockSensor = () => ({
    isAvailableAsync: jest.fn(),
    setUpdateInterval: jest.fn(),
    addListener: jest.fn(),
  });
  return {
    Accelerometer: makeMockSensor(),
    Gyroscope: makeMockSensor(),
    DeviceMotion: makeMockSensor(),
  };
});

import { Accelerometer, DeviceMotion, Gyroscope } from 'expo-sensors';
import { MotionSampler } from '../../sensors/motion-sampler';

type Listener = (reading: unknown) => void;

function mockOf<T>(value: T): jest.Mock {
  return value as unknown as jest.Mock;
}

/** Wire addListener to capture the callback and return a removable subscription. */
function wireListener(sensor: { addListener: unknown }): { remove: jest.Mock; emit: (reading: unknown) => void } {
  const remove = jest.fn();
  let captured: Listener | null = null;
  mockOf(sensor.addListener).mockImplementation((listener: Listener) => {
    captured = listener;
    return { remove };
  });
  return {
    remove,
    emit: (reading: unknown) => captured?.(reading),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('MotionSampler', () => {
  it('reports every sensor unavailable, and a well-formed empty summary, rather than crashing', async () => {
    mockOf(Accelerometer.isAvailableAsync).mockResolvedValue(false);
    mockOf(Gyroscope.isAvailableAsync).mockResolvedValue(false);
    mockOf(DeviceMotion.isAvailableAsync).mockResolvedValue(false);

    const sampler = new MotionSampler();
    await sampler.start();
    const summary = sampler.stop();

    expect(summary.accelerometerAvailable).toBe(false);
    expect(summary.gyroscopeAvailable).toBe(false);
    expect(summary.deviceMotionAvailable).toBe(false);
    expect(summary.pitchDeg).toBeUndefined();
    expect(summary.angularVelocityRmsDegPerSec).toBeUndefined();
    expect(Accelerometer.addListener).not.toHaveBeenCalled();
  });

  it('removes every subscription it created when stopped', async () => {
    mockOf(Accelerometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(DeviceMotion.isAvailableAsync).mockResolvedValue(true);
    mockOf(Gyroscope.isAvailableAsync).mockResolvedValue(false);
    const accel = wireListener(Accelerometer);
    const motion = wireListener(DeviceMotion);

    const sampler = new MotionSampler();
    await sampler.start();
    sampler.stop();

    expect(accel.remove).toHaveBeenCalledTimes(1);
    expect(motion.remove).toHaveBeenCalledTimes(1);
  });

  it('never subscribes at all if stop() is called before start() finishes probing availability', async () => {
    let resolveAvailability: (value: boolean) => void = () => {};
    mockOf(Accelerometer.isAvailableAsync).mockReturnValue(
      new Promise((resolve) => {
        resolveAvailability = resolve;
      })
    );
    mockOf(Gyroscope.isAvailableAsync).mockResolvedValue(false);
    mockOf(DeviceMotion.isAvailableAsync).mockResolvedValue(false);

    const sampler = new MotionSampler();
    const starting = sampler.start();
    sampler.stop(); // navigate away before the probe resolves
    resolveAvailability(true);
    await starting;

    expect(Accelerometer.addListener).not.toHaveBeenCalled();
  });

  it('does not throw when a subscription’s own remove() throws', async () => {
    mockOf(Accelerometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(Gyroscope.isAvailableAsync).mockResolvedValue(false);
    mockOf(DeviceMotion.isAvailableAsync).mockResolvedValue(false);
    mockOf(Accelerometer.addListener).mockImplementation(() => ({
      remove: () => {
        throw new Error('native module already torn down');
      },
    }));

    const sampler = new MotionSampler();
    await sampler.start();
    expect(() => sampler.stop()).not.toThrow();
  });

  it('feeds real readings through to the reported summary', async () => {
    mockOf(Accelerometer.isAvailableAsync).mockResolvedValue(true);
    mockOf(Gyroscope.isAvailableAsync).mockResolvedValue(false);
    mockOf(DeviceMotion.isAvailableAsync).mockResolvedValue(true);
    const accel = wireListener(Accelerometer);
    const motion = wireListener(DeviceMotion);

    const sampler = new MotionSampler();
    await sampler.start();
    accel.emit({ x: 0, y: 0, z: 1, timestamp: 0 });
    motion.emit({
      rotation: { alpha: 0, beta: 0, gamma: 0, timestamp: 0 },
      rotationRate: { alpha: 1, beta: 0, gamma: 0, timestamp: 0 },
      acceleration: { x: 0.1, y: 0, z: 0, timestamp: 0 },
      accelerationIncludingGravity: { x: 0, y: 0, z: 1, timestamp: 0 },
      interval: 100,
      orientation: 0,
    });
    const summary = sampler.stop();

    expect(summary.pitchDeg).toBeCloseTo(0, 6);
    expect(summary.rollDeg).toBeCloseTo(0, 6);
    expect(summary.angularVelocityRmsDegPerSec).toBeCloseTo(1, 6);
    expect(summary.accelerationRmsMps2).toBeCloseTo(0.1, 6);
  });
});
