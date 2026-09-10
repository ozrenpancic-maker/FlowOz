import { DEFAULT_ALPHA } from '../domain/types';

export type Language = 'en' | 'hr';
export type CsvFormat = 'international' | 'excel';

/**
 * Application settings. Everything defaults to the privacy-preserving choice:
 * no GPS unless asked for, nothing shared automatically.
 */
export interface AppSettings {
  language: Language;
  /** Site-independent fallback alpha, used when a site has no calibration. */
  defaultAlpha: number;
  /** Capture a foreground GPS fix together with each measurement. */
  captureGpsWithMeasurements: boolean;
  /** Warn when a measurement is further than this from its site [m]. */
  siteDistanceWarningM: number;
  csvFormat: CsvFormat;
  pdfIncludeGps: boolean;
  pdfIncludePhoto: boolean;
  pdfIncludeCrossSection: boolean;
  pdfIncludeMethodDetails: boolean;
  /** Default recording length offered on the video screen [s]. */
  defaultVideoDurationS: 3 | 5 | 10;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'en',
  defaultAlpha: DEFAULT_ALPHA,
  captureGpsWithMeasurements: false,
  siteDistanceWarningM: 50,
  csvFormat: 'international',
  pdfIncludeGps: true,
  pdfIncludePhoto: true,
  pdfIncludeCrossSection: true,
  pdfIncludeMethodDetails: true,
  defaultVideoDurationS: 5,
};

/** Merge a stored (possibly older) settings document onto the defaults. */
export function mergeSettings(stored: Partial<AppSettings> | null | undefined): AppSettings {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS };

  const language: Language = stored.language === 'hr' ? 'hr' : 'en';
  const csvFormat: CsvFormat = stored.csvFormat === 'excel' ? 'excel' : 'international';
  const duration = stored.defaultVideoDurationS;

  return {
    language,
    defaultAlpha:
      typeof stored.defaultAlpha === 'number' && Number.isFinite(stored.defaultAlpha) && stored.defaultAlpha > 0
        ? stored.defaultAlpha
        : DEFAULT_SETTINGS.defaultAlpha,
    captureGpsWithMeasurements: stored.captureGpsWithMeasurements === true,
    siteDistanceWarningM:
      typeof stored.siteDistanceWarningM === 'number' && stored.siteDistanceWarningM > 0
        ? stored.siteDistanceWarningM
        : DEFAULT_SETTINGS.siteDistanceWarningM,
    csvFormat,
    pdfIncludeGps: stored.pdfIncludeGps !== false,
    pdfIncludePhoto: stored.pdfIncludePhoto !== false,
    pdfIncludeCrossSection: stored.pdfIncludeCrossSection !== false,
    pdfIncludeMethodDetails: stored.pdfIncludeMethodDetails !== false,
    defaultVideoDurationS: duration === 3 || duration === 10 ? duration : 5,
  };
}
