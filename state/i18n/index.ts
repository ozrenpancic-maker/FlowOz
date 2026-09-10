import { en, type TranslationKey } from './en';
import { hr } from './hr';
import type { Language } from '../../storage/settings';

export type { TranslationKey };

export const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = {
  en,
  hr,
};

/**
 * Translate a key. Unknown keys fall back to the supplied fallback and then to
 * the key itself, so a missing string shows up as a visible key on screen
 * instead of an empty label.
 */
export function translate(language: Language, key: string, fallback?: string): string {
  const dictionary = DICTIONARIES[language] as Record<string, string | undefined>;
  return dictionary[key] ?? (DICTIONARIES.en as Record<string, string | undefined>)[key] ?? fallback ?? key;
}

export function availableLanguages(): Language[] {
  return Object.keys(DICTIONARIES) as Language[];
}
