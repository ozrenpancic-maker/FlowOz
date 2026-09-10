import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import { Repository } from '../storage/repository';
import { MemoryDocumentStore } from '../storage/document-store';
import { SqliteDocumentStore } from '../storage/sqlite-store';
import { SCHEMA_VERSION } from '../storage/migrations';
import { DEFAULT_SETTINGS, type AppSettings, type Language } from '../storage/settings';
import { translate } from './i18n';

/**
 * Settings, the repository handle and the translator, shared app-wide.
 *
 * The repository is created once and initialised before anything reads from it;
 * screens wait for `ready` rather than rendering against an empty store.
 */
interface SettingsContextValue {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  repository: Repository;
  ready: boolean;
  /** Storage initialisation failure, surfaced instead of a blank screen. */
  storageError: string | null;
  schemaVersion: number | null;
  t: (key: string, fallback?: string) => string;
  language: Language;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function createStore() {
  // The web preview has no SQLite; it runs on the in-memory store and is for
  // data inspection only — Android is where field behaviour is validated.
  return Platform.OS === 'web' ? new MemoryDocumentStore(SCHEMA_VERSION) : new SqliteDocumentStore();
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const repository = useMemo(() => new Repository(createStore()), []);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await repository.initialise();
        const stored = await repository.getSettings();
        const version = await repository.schemaVersion();
        if (cancelled) return;
        setSettings(stored);
        setSchemaVersion(version);
        setReady(true);
      } catch (error) {
        if (cancelled) return;
        setStorageError(error instanceof Error ? error.message : String(error));
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repository]);

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = { ...settings, ...patch };
      // The write is awaited first; React state follows the committed document.
      await repository.saveSettings(next);
      setSettings(next);
    },
    [repository, settings]
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      updateSettings,
      repository,
      ready,
      storageError,
      schemaVersion,
      language: settings.language,
      t: (key: string, fallback?: string) => translate(settings.language, key, fallback),
    }),
    [settings, updateSettings, repository, ready, storageError, schemaVersion]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used inside SettingsProvider');
  return context;
}

/** Convenience hook for screens that only need the translator. */
export function useTranslate() {
  return useSettings().t;
}
