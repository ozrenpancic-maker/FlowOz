import { en } from '../../state/i18n/en';
import { hr } from '../../state/i18n/hr';
import { availableLanguages, translate } from '../../state/i18n';
import { SSIV_FAILURE_CODES } from '../../video/failure-taxonomy';
import { PROVENANCE_LABEL_KEYS } from '../../domain/quality';

describe('localisation', () => {
  it('offers exactly the two required languages', () => {
    expect(availableLanguages().sort()).toEqual(['en', 'hr']);
  });

  it('translates every English key into Croatian', () => {
    const missing = Object.keys(en).filter((key) => !(key in hr));
    expect(missing).toEqual([]);
  });

  it('has no Croatian keys that English does not have', () => {
    const extra = Object.keys(hr).filter((key) => !(key in en));
    expect(extra).toEqual([]);
  });

  it('leaves no string empty in either language', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
      expect((hr as Record<string, string>)[key]?.trim().length).toBeGreaterThan(0);
    }
  });

  it('falls back to the key rather than rendering an empty label', () => {
    expect(translate('en', 'no.such.key')).toBe('no.such.key');
    expect(translate('hr', 'no.such.key', 'fallback')).toBe('fallback');
  });

  it('carries a message and an action for every SSIV failure, in both languages', () => {
    for (const code of SSIV_FAILURE_CODES) {
      for (const language of ['en', 'hr'] as const) {
        expect(translate(language, `ssiv.error.${code}`)).not.toBe(`ssiv.error.${code}`);
        expect(translate(language, `ssiv.action.${code}`)).not.toBe(`ssiv.action.${code}`);
      }
    }
  });

  it('labels every provenance value in both languages', () => {
    for (const key of Object.values(PROVENANCE_LABEL_KEYS)) {
      expect(translate('en', key)).not.toBe(key);
      expect(translate('hr', key)).not.toBe(key);
    }
  });

  it('keeps the experimental and withheld labels visible in both languages', () => {
    for (const language of ['en', 'hr'] as const) {
      expect(translate(language, 'live.badge')).toContain('BETA');
      expect(translate(language, 'live.resultBadge')).toContain('EXPERIMENTAL');
      expect(translate(language, 'quality.uncertaintyWithheld')).toBe('UNCERTAINTY NOT YET CALCULATED');
      expect(translate(language, 'video.cameraStartupFailed')).toBe('CAMERA STARTUP FAILED');
    }
  });
});
