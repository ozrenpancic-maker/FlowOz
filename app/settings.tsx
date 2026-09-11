import { useState } from 'react';
import { useRouter } from 'expo-router';

import { parseNumericInput } from '../domain/units';
import type { CsvFormat, Language } from '../storage/settings';
import { useSettings } from '../state/settings-context';
import {
  Button,
  Card,
  Choice,
  ErrorBlock,
  Field,
  KeyValue,
  Muted,
  Screen,
  SectionTitle,
  Toggle,
} from '../ui/components';

export default function SettingsScreen() {
  const router = useRouter();
  const { t, settings, updateSettings, schemaVersion } = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [alphaText, setAlphaText] = useState(String(settings.defaultAlpha));
  const [distanceText, setDistanceText] = useState(String(settings.siteDistanceWarningM));

  const apply = async (patch: Parameters<typeof updateSettings>[0]) => {
    try {
      await updateSettings(patch);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <Screen>
      {error ? (
        <ErrorBlock title={t('common.error')} detail={error} detailLabel={t('common.technicalDetail')} />
      ) : null}

      <SectionTitle>{t('settings.language')}</SectionTitle>
      <Choice
        value={settings.language}
        onChange={(language: Language) => void apply({ language })}
        options={[
          { value: 'en' as const, label: 'English' },
          { value: 'hr' as const, label: 'Hrvatski' },
        ]}
      />

      <SectionTitle>{t('settings.defaultAlpha')}</SectionTitle>
      <Field
        label="α"
        value={alphaText}
        onChangeText={setAlphaText}
        hint="0.1 – 2.0"
        invalid={(() => {
          const parsed = parseNumericInput(alphaText);
          return parsed === null || parsed <= 0;
        })()}
      />
      <Button
        label={t('common.save')}
        variant="secondary"
        onPress={() => {
          const parsed = parseNumericInput(alphaText);
          if (parsed !== null && parsed > 0) void apply({ defaultAlpha: parsed });
        }}
      />

      <SectionTitle>{t('gps.title')}</SectionTitle>
      <Toggle
        label={t('settings.gps')}
        value={settings.captureGpsWithMeasurements}
        onChange={(value) => void apply({ captureGpsWithMeasurements: value })}
      />
      <Field
        label={t('settings.siteDistanceWarning')}
        unit="m"
        value={distanceText}
        onChangeText={setDistanceText}
      />
      <Button
        label={t('common.save')}
        variant="secondary"
        onPress={() => {
          const parsed = parseNumericInput(distanceText);
          if (parsed !== null && parsed > 0) void apply({ siteDistanceWarningM: parsed });
        }}
      />

      <SectionTitle>{t('settings.csvFormat')}</SectionTitle>
      <Choice
        value={settings.csvFormat}
        onChange={(csvFormat: CsvFormat) => void apply({ csvFormat })}
        options={[
          { value: 'international' as const, label: t('settings.csv.international') },
          { value: 'excel' as const, label: t('settings.csv.excel') },
        ]}
      />

      <SectionTitle>{t('report.title')}</SectionTitle>
      <Toggle
        label={t('settings.pdfIncludeGps')}
        value={settings.pdfIncludeGps}
        onChange={(value) => void apply({ pdfIncludeGps: value })}
      />
      <Toggle
        label={t('settings.pdfIncludePhoto')}
        value={settings.pdfIncludePhoto}
        onChange={(value) => void apply({ pdfIncludePhoto: value })}
      />
      <Toggle
        label={t('settings.pdfIncludeCrossSection')}
        value={settings.pdfIncludeCrossSection}
        onChange={(value) => void apply({ pdfIncludeCrossSection: value })}
      />
      <Toggle
        label={t('settings.pdfIncludeMethodDetails')}
        value={settings.pdfIncludeMethodDetails}
        onChange={(value) => void apply({ pdfIncludeMethodDetails: value })}
      />
      <Toggle
        label={t('settings.pdfIncludeAcquisition')}
        value={settings.pdfIncludeAcquisition}
        onChange={(value) => void apply({ pdfIncludeAcquisition: value })}
      />

      <SectionTitle>{t('settings.videoDuration')}</SectionTitle>
      <Choice
        value={settings.defaultVideoDurationS}
        onChange={(value: 3 | 5 | 10) => void apply({ defaultVideoDurationS: value })}
        options={[
          { value: 3 as const, label: '3 s' },
          { value: 5 as const, label: '5 s' },
          { value: 10 as const, label: '10 s' },
        ]}
      />

      <SectionTitle>{t('settings.engineering')}</SectionTitle>
      <Button
        label={t('capabilities.title')}
        variant="secondary"
        onPress={() => router.push('/device-capabilities')}
      />

      <SectionTitle>{t('settings.about')}</SectionTitle>
      <Muted>{t('settings.aboutBody')}</Muted>
      <Card>
        <KeyValue label={t('settings.schemaVersion')} value={String(schemaVersion ?? '—')} />
        <KeyValue label={t('app.offline')} value={t('common.yes')} />
      </Card>
      <Muted>{t('report.disclaimer.fieldEstimate')}</Muted>
      <Muted>{t('report.disclaimer.noTraceableValidation')}</Muted>
      <Muted>{t('report.disclaimer.uncertaintyWithheld')}</Muted>
    </Screen>
  );
}
