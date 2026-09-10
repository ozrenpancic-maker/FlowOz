import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { draftFromSite, emptyDraft, retryDraftFrom } from '../domain/draft';
import type { SavedMeasurement } from '../domain/measurement';
import type { MeasurementDraft, Site } from '../domain/types';
import { DEFAULT_ALPHA } from '../domain/types';
import type { SsivAnalysis } from '../video/types';

export { draftFromSite, emptyDimensions, emptyDraft, retryDraftFrom } from '../domain/draft';

/**
 * React state for the in-progress measurement. The draft itself is built by the
 * pure helpers in domain/draft.
 */

interface MeasurementContextValue {
  draft: MeasurementDraft;
  setDraft: (updater: (current: MeasurementDraft) => MeasurementDraft) => void;
  patchDraft: (patch: Partial<MeasurementDraft>) => void;
  analysis: SsivAnalysis | null;
  setAnalysis: (analysis: SsivAnalysis | null) => void;
  reset: (defaultAlpha?: number) => void;
  startFromSite: (site: Site) => void;
  startRetry: (measurement: SavedMeasurement) => void;
  /** Id of the measurement a retry started from, for the "unchanged original" note. */
  retryOriginId: string | null;
  acknowledgedAdvisories: boolean;
  setAcknowledgedAdvisories: (value: boolean) => void;
}

const MeasurementContext = createContext<MeasurementContextValue | null>(null);

export function MeasurementProvider({
  children,
  defaultAlpha = DEFAULT_ALPHA,
}: {
  children: ReactNode;
  defaultAlpha?: number;
}) {
  const [draft, setDraftState] = useState<MeasurementDraft>(() => emptyDraft(defaultAlpha));
  const [analysis, setAnalysis] = useState<SsivAnalysis | null>(null);
  const [retryOriginId, setRetryOriginId] = useState<string | null>(null);
  const [acknowledgedAdvisories, setAcknowledgedAdvisories] = useState(false);

  const setDraft = useCallback(
    (updater: (current: MeasurementDraft) => MeasurementDraft) => {
      setDraftState((current) => updater(current));
      setAcknowledgedAdvisories(false);
    },
    []
  );

  const patchDraft = useCallback(
    (patch: Partial<MeasurementDraft>) => {
      setDraft((current) => ({ ...current, ...patch }));
    },
    [setDraft]
  );

  const reset = useCallback(
    (alpha = defaultAlpha) => {
      setDraftState(emptyDraft(alpha));
      setAnalysis(null);
      setRetryOriginId(null);
      setAcknowledgedAdvisories(false);
    },
    [defaultAlpha]
  );

  const startFromSite = useCallback((site: Site) => {
    setDraftState(draftFromSite(site));
    setAnalysis(null);
    setRetryOriginId(null);
    setAcknowledgedAdvisories(false);
  }, []);

  const startRetry = useCallback((measurement: SavedMeasurement) => {
    setDraftState(retryDraftFrom(measurement));
    setAnalysis(null);
    setRetryOriginId(measurement.id);
    setAcknowledgedAdvisories(false);
  }, []);

  const value = useMemo<MeasurementContextValue>(
    () => ({
      draft,
      setDraft,
      patchDraft,
      analysis,
      setAnalysis,
      reset,
      startFromSite,
      startRetry,
      retryOriginId,
      acknowledgedAdvisories,
      setAcknowledgedAdvisories,
    }),
    [
      draft,
      setDraft,
      patchDraft,
      analysis,
      reset,
      startFromSite,
      startRetry,
      retryOriginId,
      acknowledgedAdvisories,
    ]
  );

  return <MeasurementContext.Provider value={value}>{children}</MeasurementContext.Provider>;
}

export function useMeasurement(): MeasurementContextValue {
  const context = useContext(MeasurementContext);
  if (!context) throw new Error('useMeasurement must be used inside MeasurementProvider');
  return context;
}
