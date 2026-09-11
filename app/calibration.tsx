import { useCallback, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';

import { activeAlpha, calibratedDepthRange, deriveAlpha } from '../domain/calibration';
import { computeSection } from '../domain/geometry';
import { createId } from '../domain/ids';
import type { Site } from '../domain/types';
import { formatNumber, fromMetres, parseNumericInput, toMetres } from '../domain/units';
import { useSettings } from '../state/settings-context';
import {
  Badge,
  Button,
  Card,
  Choice,
  ErrorBlock,
  Field,
  Muted,
  Note,
  Screen,
  SectionTitle,
  ValueRow,
} from '../ui/components';
import { colors, typography } from '../ui/theme';

/**
 * Alpha calibration.
 *
 * α = Qreference / (A · Vsurface). A point whose alpha lands outside the
 * defensible band is stored as invalid with its reason and never moves the
 * site's active alpha.
 */
export default function CalibrationScreen() {
  const params = useLocalSearchParams<{ siteId?: string }>();
  const { t, repository, ready } = useSettings();

  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string | null>(params.siteId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [depthText, setDepthText] = useState('');
  const [velocityText, setVelocityText] = useState('');
  const [flowText, setFlowText] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [certificate, setCertificate] = useState('');
  const [calibrationDate, setCalibrationDate] = useState('');
  const [uncertainty, setUncertainty] = useState('');

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      const list = await repository.listSites();
      setSites(list);
      if (!siteId && list.length > 0) setSiteId((list[0] as Site).id);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [ready, repository, siteId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const site = sites.find((entry) => entry.id === siteId) ?? null;
  const alpha = site ? activeAlpha(site.calibrationPoints) : null;
  const calibratedRange = site ? calibratedDepthRange(site.calibrationPoints) : null;

  const addPoint = async () => {
    if (!site || busy) return;
    const depth = parseNumericInput(depthText);
    const surfaceVelocity = parseNumericInput(velocityText);
    const referenceFlow = parseNumericInput(flowText);

    if (depth === null || surfaceVelocity === null || referenceFlow === null) {
      setError(t('calculation.error.missingDepth'));
      return;
    }

    const depthM = toMetres(depth, site.draft.unit);
    const section = computeSection(site.draft.dimensions, depthM);
    if (!section.ok) {
      setError(`${t(section.error.messageKey)} ${section.error.detail ?? ''}`);
      return;
    }

    const point = deriveAlpha({
      id: createId('cal'),
      createdAt: new Date().toISOString(),
      depth: depthM,
      area: section.value.area,
      surfaceVelocity,
      referenceFlow,
      reference: {
        ...(manufacturer ? { manufacturer } : {}),
        ...(model ? { model } : {}),
        ...(serialNumber ? { serialNumber } : {}),
        ...(certificate ? { certificate } : {}),
        ...(calibrationDate ? { calibrationDate } : {}),
        ...(uncertainty ? { uncertainty } : {}),
      },
    });

    if (!point.ok) {
      setError(`${t(point.error.messageKey)} ${point.error.detail ?? ''}`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const points = [...site.calibrationPoints, point.value];
      const next = activeAlpha(points);
      const updated: Site = {
        ...site,
        calibrationPoints: points,
        alpha: next.alpha,
        alphaStatus: next.status,
        updatedAt: new Date().toISOString(),
      };
      await repository.saveSite(updated);
      setSites((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      setDepthText('');
      setVelocityText('');
      setFlowText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <SectionTitle>{t('calibration.title')}</SectionTitle>
      <Muted>{t('calibration.hint')}</Muted>

      {error ? (
        <ErrorBlock title={t('common.error')} detail={error} detailLabel={t('common.technicalDetail')} />
      ) : null}

      {sites.length === 0 ? <Muted>{t('sites.empty')}</Muted> : null}
      {sites.length > 0 ? (
        <Choice
          label={t('sites.title')}
          value={siteId ?? ''}
          onChange={setSiteId}
          options={sites.map((entry) => ({ value: entry.id, label: entry.name }))}
        />
      ) : null}

      {site && alpha ? (
        <>
          <Card>
            <ValueRow
              label={t('calibration.activeAlpha')}
              value={formatNumber(alpha.alpha, 4)}
              provenance={alpha.status === 'calibrated' ? t('provenance.calibrated') : t('provenance.assumed')}
            />
            <Badge
              label={t(`alphaStatus.${alpha.status}`)}
              tone={alpha.status === 'calibrated' ? 'pass' : 'warning'}
            />
            <Muted>
              {t('calibration.points')}: {alpha.pointCount} / {site.calibrationPoints.length}
            </Muted>
            {calibratedRange ? (
              <ValueRow
                label={t('calibration.range')}
                value={`${formatNumber(fromMetres(calibratedRange.minDepth, site.draft.unit), 3)} – ${formatNumber(fromMetres(calibratedRange.maxDepth, site.draft.unit), 3)}`}
                unit={site.draft.unit}
                detail={t('calibration.rangeHint')}
              />
            ) : null}
          </Card>

          <SectionTitle>{t('calibration.addPoint')}</SectionTitle>
          <Field label={`${t('calibration.depth')} (${site.draft.unit})`} value={depthText} onChangeText={setDepthText} />
          <Field label={t('calibration.surfaceVelocity')} unit="m/s" value={velocityText} onChangeText={setVelocityText} />
          <Field label={t('calibration.referenceFlow')} unit="m³/s" value={flowText} onChangeText={setFlowText} />

          <SectionTitle>{t('calibration.instrument')}</SectionTitle>
          <Field label={t('calibration.manufacturer')} keyboardType="default" value={manufacturer} onChangeText={setManufacturer} />
          <Field label={t('calibration.model')} keyboardType="default" value={model} onChangeText={setModel} />
          <Field label={t('calibration.serialNumber')} keyboardType="default" value={serialNumber} onChangeText={setSerialNumber} />
          <Field label={t('calibration.certificate')} keyboardType="default" value={certificate} onChangeText={setCertificate} />
          <Field label={t('calibration.calibrationDate')} keyboardType="default" value={calibrationDate} onChangeText={setCalibrationDate} />
          <Field label={t('calibration.uncertainty')} keyboardType="default" value={uncertainty} onChangeText={setUncertainty} />

          <Button label={t('calibration.addPoint')} onPress={addPoint} busy={busy} disabled={busy} />

          <SectionTitle>{t('calibration.points')}</SectionTitle>
          {site.calibrationPoints.length === 0 ? <Muted>{t('common.none')}</Muted> : null}
          {site.calibrationPoints.map((point) => (
            <Card key={point.id} tone={point.valid ? 'neutral' : 'warning'}>
              <Text style={styles.pointId}>{point.createdAt}</Text>
              <ValueRow label="α" value={formatNumber(point.alpha, 4)} />
              <ValueRow label={t('calibration.referenceFlow')} value={formatNumber(point.referenceFlow, 5)} unit="m³/s" />
              <ValueRow label={t('report.area')} value={formatNumber(point.area, 5)} unit="m²" />
              <ValueRow label={t('calibration.surfaceVelocity')} value={formatNumber(point.surfaceVelocity, 4)} unit="m/s" />
              {!point.valid ? <Note tone="warning">{t('calibration.invalidPoint')}</Note> : null}
              {point.reference?.serialNumber ? (
                <Muted>
                  {point.reference.manufacturer ?? ''} {point.reference.model ?? ''} · {point.reference.serialNumber}
                </Muted>
              ) : null}
            </Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pointId: { ...typography.small, color: colors.textFaint },
});
