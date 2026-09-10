import { escapeCell, CSV_DIALECTS } from '../../reports/csv';
import { mergeSettings } from '../../storage/settings';

export { COLLECTIONS, indexRow, isSavedMeasurement, isSite } from '../../storage/serialization';

/** Guards that keep the shared fixtures honest across suites. */
export function escapeCellFixtureGuard(): boolean {
  return escapeCell('plain', CSV_DIALECTS.international) === 'plain';
}

export function mergeSettingsGuard(): boolean {
  return mergeSettings(undefined).language === 'en';
}
