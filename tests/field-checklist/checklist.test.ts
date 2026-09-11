import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The physical field gate is a human procedure, not something a test runner can
 * execute. What is checked here is that the procedure is present, complete and
 * has not silently lost a step — so nobody can declare the gate passed against
 * a checklist that quietly shrank.
 */
const checklist = readFileSync(join(__dirname, 'FIELD-GATE.md'), 'utf8');

describe('field gate checklist', () => {
  it('states the 20 consecutive run criterion', () => {
    expect(checklist).toContain('20 consecutive');
  });

  it('lists all four disqualifying failures', () => {
    for (const failure of [
      'no crash',
      'no lost measurement',
      'no camera startup failure',
      'no unexplained blank screen',
    ]) {
      expect(checklist).toContain(failure);
    }
  });

  it('keeps all ten steps of a run', () => {
    for (let step = 1; step <= 10; step += 1) {
      expect(checklist).toContain(`| ${step} |`);
    }
  });

  it('keeps a numbered log row for each of the 20 runs', () => {
    for (let run = 1; run <= 20; run += 1) {
      expect(checklist).toMatch(new RegExp(`\\|\\s${run}\\s\\|`));
    }
  });

  it('records that Live Flow stays paused until the gate passes', () => {
    expect(checklist).toContain('Live Flow development stays paused');
  });

  it('requires the awkward cases to be exercised, not only the easy one', () => {
    expect(checklist).toContain('INSUFFICIENT TEXTURE');
    expect(checklist).toContain('UNSTABLE CAMERA');
    expect(checklist).toContain('RETRY VIDEO MEASUREMENT');
    expect(checklist).toContain('permanently blocked');
  });
});

describe('v1.0.7 upgrade checklist', () => {
  const upgradeChecklist = readFileSync(join(__dirname, 'V1.0.7-UPGRADE-CHECKLIST.md'), 'utf8');

  it('keeps all 20 items', () => {
    for (let item = 1; item <= 20; item += 1) {
      expect(upgradeChecklist).toContain(`| ${item} |`);
    }
  });

  it('names the exact version being verified', () => {
    expect(upgradeChecklist).toContain('versionName 1.0.7');
    expect(upgradeChecklist).toContain('versionCode 8');
  });

  it('requires installing over the previous build, not a clean reinstall', () => {
    expect(upgradeChecklist).toContain('Install the new APK over versionCode 7');
    expect(upgradeChecklist).toContain('do not uninstall first');
  });

  it('covers sensor evidence, not just the happy-path measurement', () => {
    for (const evidence of ['SensorSnapshot', 'pitch/roll', 'RMS', 'UNAVAILABLE']) {
      expect(upgradeChecklist).toContain(evidence);
    }
  });

  it('covers the new draggable water-line editor', () => {
    expect(upgradeChecklist).toContain('rotation handle');
    expect(upgradeChecklist).toContain('Undo');
    expect(upgradeChecklist).toContain('Reset');
  });

  it('never claims this checklist proves measurement accuracy', () => {
    expect(upgradeChecklist).toContain('does not establish measurement');
  });

  it('ties this checklist to Live Flow staying paused', () => {
    expect(upgradeChecklist).toContain('Live Flow');
  });
});
