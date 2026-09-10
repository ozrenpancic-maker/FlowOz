import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { useSettings } from '../state/settings-context';
import { Badge, Card, Muted, Note, Screen, SectionTitle, ValueRow } from '../ui/components';

/**
 * Live Flow — beta, development paused.
 *
 * The concept and any stored sessions are preserved; nothing here starts a
 * continuous recording or touches the Live Flow lifecycle. That work is gated
 * behind 20 consecutive successful physical Android single-video measurements,
 * and every Live Flow result stays labelled experimental.
 */
export default function LiveFlowScreen() {
  const { t, repository, ready } = useSettings();
  const [sessions, setSessions] = useState<unknown[]>([]);

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      setSessions(await repository.listLiveSessions());
    } catch {
      setSessions([]);
    }
  }, [ready, repository]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  return (
    <Screen>
      <Badge label={t('live.badge')} tone="experimental" />
      <SectionTitle>{t('live.title')}</SectionTitle>
      <Note tone="warning">{t('live.body')}</Note>
      <Badge label={t('live.resultBadge')} tone="error" />

      <SectionTitle>{t('live.concept')}</SectionTitle>
      <Muted>{t('live.conceptBody')}</Muted>

      <SectionTitle>{t('live.gateStatus')}</SectionTitle>
      <Card>
        <ValueRow label={t('validation.fieldGate')} value="0 / 20" tone="warning" />
        <Muted>{t('validation.noEvidence')}</Muted>
      </Card>

      <SectionTitle>{t('live.sessions')}</SectionTitle>
      {sessions.length === 0 ? <Muted>{t('live.noSessions')}</Muted> : null}
      {sessions.map((session, index) => (
        <Card key={index}>
          <Muted>{JSON.stringify(session).slice(0, 400)}</Muted>
        </Card>
      ))}
    </Screen>
  );
}
