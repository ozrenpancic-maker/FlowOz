import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { calculate, buildSavedMeasurement, type CalculationOutcome } from '../domain/measurement';
import { createDisplayId, createId } from '../domain/ids';
import { maximumDepth } from '../domain/geometry';
import { activeAlpha } from '../domain/calibration';
import { classifyAccuracy, compareWithSite, type GpsAccuracyClass } from '../domain/gps';
import {
  CUSTOM_ROUGHNESS_ID,
  ROUGHNESS_MATERIALS,
  findMaterial,
  isOutsideBand,
  materialLabelKey,
} from '../domain/roughness';
import type { Dimensions, LengthUnit, Site, VelocityMethod } from '../domain/types';
import {
  degreesToPermille,
  formatNumber,
  fromMetres,
  permilleToDegrees,
  toMetres,
  type SlopeUnit,
} from '../domain/units';
import { captureGps } from '../state/gps-capture';
import { useMeasurement } from '../state/measurement-context';
import { useSettings } from '../state/settings-context';
import {
  Badge,
  Button,
  Card,
  Choice,
  ErrorBlock,
  Muted,
  NumberField,
  Note,
  Screen,
  SectionTitle,
  Select,
  Toggle,
  ValueRow,
} from '../ui/components';
import { colors, gradeTone, spacing, typography, type QualityTone } from '../ui/theme';

type Step = 'site' | 'geometry' | 'level' | 'velocity' | 'review' | 'result';

const STEP_ORDER: Step[] = ['site', 'geometry', 'level', 'velocity', 'review', 'result'];

const STEP_TITLE_KEY: Record<Step, string> = {
  site: 'measure.step.site',
  geometry: 'measure.step.geometry',
  level: 'measure.step.level',
  velocity: 'measure.step.velocity',
  review: 'measure.step.review',
  result: 'measure.step.result',
};

const GPS_TONES: Record<GpsAccuracyClass, QualityTone> = {
  GOOD: 'pass',
  ACCEPTABLE: 'neutral',
  POOR: 'warning',
  UNKNOWN: 'neutral',
};

export default function MeasureScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ quick?: string; step?: string }>();
  const { t, repository, settings, ready } = useSettings();
  const { draft, patchDraft, analysis, startFromSite, acknowledgedAdvisories, setAcknowledgedAdvisories, retryOriginId } =
    useMeasurement();

  const quick = params.quick === '1';
  const [step, setStep] = useState<Step>(() => (quick ? 'geometry' : (params.step as Step) ?? 'site'));
  const [sites, setSites] = useState<Site[] | null>(null);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [capturingGps, setCapturingGps] = useState(false);
  // A draft started from a site arrives with the site's stored position, which
  // is not the same claim as a fix taken here and must not be labelled as one.
  const [liveFix, setLiveFix] = useState(false);

  // An explicit fix, so the operator sees the position and its accuracy before
  // saving rather than discovering it in the report afterwards.
  const captureGpsNow = useCallback(async () => {
    setCapturingGps(true);
    try {
      const fix = await captureGps();
      if (fix.ok) {
        patchDraft({ location: fix.location });
        setLiveFix(true);
        setGpsNote(null);
      } else {
        setGpsNote(`${t('measure.gpsFailed')} ${t(fix.reasonKey)}`);
      }
    } finally {
      setCapturingGps(false);
    }
  }, [patchDraft, t]);

  const gpsClass = classifyAccuracy(draft.location?.accuracy);
  const siteDistance = useMemo(() => {
    if (!liveFix || !draft.location || !draft.siteId) return null;
    const site = sites?.find((entry) => entry.id === draft.siteId);
    if (!site?.location) return null;
    return compareWithSite(draft.location, site.location, settings.siteDistanceWarningM);
  }, [liveFix, draft.location, draft.siteId, sites, settings.siteDistanceWarningM]);

  // Load sites lazily, only when the site step is actually shown.
  const loadSites = useCallback(async () => {
    if (!ready) return;
    try {
      setSites(await repository.listSites());
      setSitesError(null);
    } catch (error) {
      setSitesError(error instanceof Error ? error.message : String(error));
    }
  }, [ready, repository]);

  useEffect(() => {
    if (step === 'site' && sites === null) void loadSites();
  }, [step, sites, loadSites]);

  const calculation = useMemo(
    () => calculate(draft, { ...(analysis ? { analysis } : {}), acknowledgedAdvisories }),
    [draft, analysis, acknowledgedAdvisories]
  );

  const goto = (next: Step) => setStep(next);
  const stepIndex = STEP_ORDER.indexOf(step);

  // ------------------------------------------------------------------ saving

  const save = async () => {
    if (saving || !calculation.ok) return;
    setSaving(true); // disables the button for the whole write
    setSaveError(null);

    try {
      let location = draft.location;
      if (settings.captureGpsWithMeasurements) {
        const fix = await captureGps();
        if (fix.ok) {
          location = fix.location;
          setGpsNote(null);
        } else {
          // A GPS failure never blocks the save; it is stated on the result.
          setGpsNote(`${t('measure.gpsFailed')} ${t(fix.reasonKey)}`);
        }
      }

      const at = new Date();
      const measurement = buildSavedMeasurement(
        createId('m', at),
        createDisplayId('FV', at),
        { ...draft, ...(location ? { location } : {}) },
        calculation.value,
        { ...(analysis ? { analysis } : {}), createdAt: at.toISOString() }
      );

      await repository.saveMeasurement(measurement);
      setSavedId(measurement.id);
    } catch (error) {
      // The screen stays open with everything on it.
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------------- steps

  const renderSiteStep = () => (
    <>
      <SectionTitle>{t('measure.selectSite')}</SectionTitle>
      {sitesError ? (
        <ErrorBlock title={t('common.error')} detail={sitesError} detailLabel={t('common.technicalDetail')} />
      ) : null}
      {sites === null ? <Muted>{t('common.loading')}</Muted> : null}
      {sites?.length === 0 ? <Muted>{t('sites.empty')}</Muted> : null}
      {sites?.map((site) => {
        const alpha = activeAlpha(site.calibrationPoints);
        return (
          <Card key={site.id}>
            <Text style={styles.siteName}>{site.name}</Text>
            <Muted>
              {t('calibration.activeAlpha')}: {formatNumber(alpha.alpha, 3)} ·{' '}
              {t(`alphaStatus.${alpha.status}`)}
            </Muted>
            <Button
              label={t('sites.openMeasurement')}
              onPress={() => {
                startFromSite(site);
                goto('geometry');
              }}
            />
          </Card>
        );
      })}
      <Button label={t('measure.oneOff')} variant="secondary" onPress={() => goto('geometry')} />
    </>
  );

  const renderGeometryStep = () => (
    <GeometryStep
      draft={draft}
      patchDraft={patchDraft}
      t={t}
      onNext={() => goto('level')}
    />
  );

  const renderLevelStep = () => (
    <LevelStep draft={draft} patchDraft={patchDraft} t={t} onNext={() => goto('velocity')} onCamera={() => router.push('/level-camera')} />
  );

  const renderVelocityStep = () => (
    <VelocityStep
      draft={draft}
      patchDraft={patchDraft}
      t={t}
      hasAnalysis={analysis !== null}
      onOpenVideo={() => router.push('/video')}
      onNext={() => goto('review')}
    />
  );

  const renderReviewStep = () => (
    <>
      <SectionTitle>{t('measure.reviewTitle')}</SectionTitle>
      <Muted>{t('measure.reviewHint')}</Muted>

      <Card>
        <ValueRow
          label={t('report.site')}
          value={draft.siteName ?? t('measure.oneOff')}
          provenance={draft.siteId ? t('provenance.site') : t('provenance.entered')}
        />
        <ValueRow label={t('report.geometryKind')} value={t(`measure.geometry.${draft.dimensions.kind}`)} />
        {describeDimensions(draft.dimensions).map((row) => (
          <ValueRow key={row.label} label={row.label} value={row.value} unit={row.unit} provenance={draft.siteId ? t('provenance.site') : t('provenance.entered')} />
        ))}
        <ValueRow
          label={t('measure.depth')}
          value={formatNumber(draft.depth, 4)}
          unit="m"
          provenance={draft.levelMethod === 'camera-assisted' ? t('provenance.measured') : t('provenance.entered')}
        />
        <ValueRow label={t('report.method')} value={t(`measure.method.${draft.method}`)} />
        {draft.method === 'manning' ? (
          <>
            {draft.material ? (
              <ValueRow
                label={t('measure.material')}
                value={t(materialLabelKey(draft.material))}
                provenance={t('provenance.entered')}
              />
            ) : null}
            <ValueRow label={t('measure.roughness')} value={formatNumber(draft.roughness, 4)} provenance={t('provenance.assumed')} />
            <ValueRow label={t('measure.slopePermille')} value={formatNumber(draft.slopePermille, 3)} unit="‰" provenance={t('provenance.entered')} />
          </>
        ) : null}
        {draft.method === 'manual' ? (
          <ValueRow label={t('measure.manualVelocity')} value={formatNumber(draft.manualVelocity, 4)} unit="m/s" provenance={t('provenance.entered')} />
        ) : null}
        {draft.method === 'video' ? (
          <>
            <ValueRow
              label={t('video.surfaceVelocity')}
              value={formatNumber(analysis?.surfaceVelocity ?? draft.surfaceVelocity ?? null, 4)}
              unit="m/s"
              provenance={t('provenance.measuredVideo')}
              withheld={(analysis?.surfaceVelocity ?? draft.surfaceVelocity) === undefined}
            />
            <ValueRow
              label={t('video.alphaUsed')}
              value={formatNumber(draft.alpha, 3)}
              provenance={t(`provenance.${draft.alphaProvenance.toLowerCase()}`)}
            />
            <Badge label={t('video.experimentalBadge')} tone="experimental" />
          </>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>{t('gps.title')}</SectionTitle>
        {draft.location ? (
          <>
            <ValueRow
              label={t('report.latitude')}
              value={draft.location.latitude.toFixed(6)}
              unit="°"
              provenance={liveFix ? t('provenance.measured') : t('provenance.site')}
            />
            <ValueRow
              label={t('report.longitude')}
              value={draft.location.longitude.toFixed(6)}
              unit="°"
              provenance={liveFix ? t('provenance.measured') : t('provenance.site')}
            />
            <ValueRow
              label={t('gps.accuracy')}
              value={formatNumber(draft.location.accuracy ?? null, 1)}
              unit="m"
            />
            <Badge
              label={t(`gps.class.${gpsClass}`)}
              tone={GPS_TONES[gpsClass]}
            />
            {siteDistance?.exceedsThreshold ? (
              <Note tone="warning">
                {t('gps.distanceWarning')} {siteDistance.distanceM.toFixed(0)} m
              </Note>
            ) : null}
          </>
        ) : (
          <Muted>{t('gps.notCaptured')}</Muted>
        )}
        <Button
          label={capturingGps ? t('gps.capturing') : t('gps.capture')}
          variant="secondary"
          disabled={capturingGps}
          onPress={() => void captureGpsNow()}
        />
        {gpsNote ? <Note tone="warning">{gpsNote}</Note> : null}
      </Card>

      {calculation.ok && calculation.value.plausibility.advisories.length > 0 ? (
        <Card tone="warning">
          <SectionTitle>{t('common.warning')}</SectionTitle>
          {calculation.value.plausibility.advisories.map((finding) => (
            <Note key={`${finding.field}-${finding.code}`} tone="warning">
              {t(finding.messageKey)} — {finding.field} = {finding.value} {finding.detail ?? ''}
            </Note>
          ))}
          <Toggle
            label={t('measure.acknowledgeAdvisories')}
            value={acknowledgedAdvisories}
            onChange={setAcknowledgedAdvisories}
          />
        </Card>
      ) : null}

      {!calculation.ok ? (
        <ErrorBlock
          title={t(calculation.error.messageKey)}
          action={calculation.error.code === 'PLAUSIBILITY_BLOCKED' ? t('measure.blocked') : undefined}
          detail={calculation.error.detail}
          detailLabel={t('common.technicalDetail')}
        />
      ) : null}

      <Button
        label={t('measure.calculate')}
        onPress={() => goto('result')}
        disabled={
          !calculation.ok ||
          (calculation.value.plausibility.advisories.length > 0 && !acknowledgedAdvisories)
        }
      />
    </>
  );

  const renderResultStep = () => {
    if (!calculation.ok) {
      return (
        <ErrorBlock
          title={t(calculation.error.messageKey)}
          detail={calculation.error.detail}
          detailLabel={t('common.technicalDetail')}
        >
          <Button label={t('common.back')} variant="secondary" onPress={() => goto('review')} />
        </ErrorBlock>
      );
    }

    const value = calculation.value;
    return (
      <>
        <SectionTitle>{t('measure.step.result')}</SectionTitle>
        <Card tone={gradeTone(value.quality.overall.grade)}>
          <ValueRow
            label={t('report.flowM3s')}
            value={formatNumber(value.flowM3s, 5)}
            unit="m³/s"
            provenance={t('provenance.calculated')}
          />
          <ValueRow label={t('report.flowLs')} value={formatNumber(value.flowM3s * 1000, 2)} unit="l/s" />
          <ValueRow label={t('report.meanVelocity')} value={formatNumber(value.velocity, 4)} unit="m/s" />
          <ValueRow label={t('report.area')} value={formatNumber(value.section.area, 5)} unit="m²" />
          <ValueRow label={t('report.hydraulicRadius')} value={formatNumber(value.section.hydraulicRadius, 5)} unit="m" />
          {value.section.fillRatio !== undefined ? (
            <ValueRow label={t('report.fillRatio')} value={formatNumber(value.section.fillRatio, 3)} />
          ) : null}
          <ValueRow
            label={t('report.overallQuality')}
            value={value.quality.overall.grade}
            detail={t(value.quality.overall.reasonKey)}
            tone={gradeTone(value.quality.overall.grade)}
          />
          <ValueRow label={t('quality.uncertainty')} value={t('quality.uncertaintyWithheld')} withheld />
        </Card>

        {retryOriginId ? <Note tone="warning">{t('video.retryHint')}</Note> : null}
        {gpsNote ? <Note tone="warning">{gpsNote}</Note> : null}

        {saveError ? (
          <ErrorBlock
            title={t('measure.saveFailed')}
            detail={saveError}
            detailLabel={t('common.technicalDetail')}
          />
        ) : null}

        {savedId ? (
          <>
            <Note tone="pass">{t('measure.saved')}</Note>
            <Button label={t('saved.title')} onPress={() => router.replace(`/saved/${savedId}`)} />
          </>
        ) : (
          <Button
            label={saving ? t('common.saving') : t('measure.saveMeasurement')}
            onPress={save}
            busy={saving}
            disabled={saving}
          />
        )}
      </>
    );
  };

  return (
    <Screen>
      <View style={styles.stepper}>
        {STEP_ORDER.map((entry, index) => (
          <Text
            key={entry}
            style={[
              styles.stepLabel,
              index === stepIndex && styles.stepLabelActive,
              index < stepIndex && styles.stepLabelDone,
            ]}
          >
            {t(STEP_TITLE_KEY[entry])}
          </Text>
        ))}
      </View>

      {step === 'site' ? renderSiteStep() : null}
      {step === 'geometry' ? renderGeometryStep() : null}
      {step === 'level' ? renderLevelStep() : null}
      {step === 'velocity' ? renderVelocityStep() : null}
      {step === 'review' ? renderReviewStep() : null}
      {step === 'result' ? renderResultStep() : null}

      {stepIndex > 0 && !savedId ? (
        <Button
          label={t('common.back')}
          variant="secondary"
          onPress={() => goto(STEP_ORDER[Math.max(0, stepIndex - 1)] as Step)}
        />
      ) : null}
    </Screen>
  );
}

// ---------------------------------------------------------------- sub-steps

function GeometryStep({
  draft,
  patchDraft,
  t,
  onNext,
}: {
  draft: ReturnType<typeof useMeasurement>['draft'];
  patchDraft: ReturnType<typeof useMeasurement>['patchDraft'];
  t: (key: string, fallback?: string) => string;
  onNext: () => void;
}) {
  const unit = draft.unit;
  const setKind = (kind: Dimensions['kind']) => {
    patchDraft({ geometry: kind, dimensions: defaultDimensionsFor(kind) });
  };

  const dimensionField = (
    label: string,
    metres: number,
    apply: (nextMetres: number) => void,
    hint?: string
  ) => (
    <NumberField
      label={label}
      unit={unit}
      value={metres > 0 ? fromMetres(metres, unit) : null}
      decimals={4}
      hint={hint}
      onChange={(next) => {
        apply(next === null ? 0 : toMetres(next, unit));
      }}
    />
  );

  return (
    <>
      <SectionTitle>{t('measure.step.geometry')}</SectionTitle>
      <Choice
        label={t('measure.geometryKind')}
        value={draft.dimensions.kind}
        onChange={setKind}
        options={[
          { value: 'circular' as const, label: t('measure.geometry.circular') },
          { value: 'rectangular' as const, label: t('measure.geometry.rectangular') },
          { value: 'trapezoidal' as const, label: t('measure.geometry.trapezoidal') },
        ]}
      />
      <Choice
        label={t('measure.unit')}
        value={unit}
        onChange={(next: LengthUnit) => patchDraft({ unit: next })}
        options={[
          { value: 'mm' as const, label: 'mm' },
          { value: 'cm' as const, label: 'cm' },
          { value: 'm' as const, label: 'm' },
        ]}
      />

      {draft.dimensions.kind === 'circular'
        ? dimensionField(t('measure.diameter'), draft.dimensions.diameter, (value) =>
            patchDraft({ dimensions: { kind: 'circular', diameter: value } })
          )
        : null}

      {draft.dimensions.kind === 'rectangular' ? (
        <>
          {dimensionField(t('measure.width'), draft.dimensions.width, (value) =>
            patchDraft({
              dimensions: {
                kind: 'rectangular',
                width: value,
                ...(draft.dimensions.kind === 'rectangular' && draft.dimensions.totalHeight !== undefined
                  ? { totalHeight: draft.dimensions.totalHeight }
                  : {}),
              },
            })
          )}
          {dimensionField(
            `${t('measure.totalHeight')} (${t('common.optional')})`,
            draft.dimensions.totalHeight ?? 0,
            (value) =>
              patchDraft({
                dimensions: {
                  kind: 'rectangular',
                  width: draft.dimensions.kind === 'rectangular' ? draft.dimensions.width : 0,
                  ...(value > 0 ? { totalHeight: value } : {}),
                },
              })
          )}
        </>
      ) : null}

      {draft.dimensions.kind === 'trapezoidal' ? (
        <>
          {dimensionField(t('measure.bottomWidth'), draft.dimensions.bottomWidth, (value) =>
            patchDraft({
              dimensions:
                draft.dimensions.kind === 'trapezoidal'
                  ? { ...draft.dimensions, bottomWidth: value }
                  : draft.dimensions,
            })
          )}
          <SlopeEditor
            label={t('measure.leftSlope')}
            slope={draft.dimensions.leftSlope}
            unit={unit}
            t={t}
            onChange={(slope) =>
              patchDraft({
                dimensions:
                  draft.dimensions.kind === 'trapezoidal'
                    ? { ...draft.dimensions, leftSlope: slope }
                    : draft.dimensions,
              })
            }
          />
          <SlopeEditor
            label={t('measure.rightSlope')}
            slope={draft.dimensions.rightSlope}
            unit={unit}
            t={t}
            onChange={(slope) =>
              patchDraft({
                dimensions:
                  draft.dimensions.kind === 'trapezoidal'
                    ? { ...draft.dimensions, rightSlope: slope }
                    : draft.dimensions,
              })
            }
          />
        </>
      ) : null}

      <Button label={t('common.next')} onPress={onNext} />
    </>
  );
}

function SlopeEditor({
  label,
  slope,
  unit,
  t,
  onChange,
}: {
  label: string;
  slope: Extract<Dimensions, { kind: 'trapezoidal' }>['leftSlope'];
  unit: LengthUnit;
  t: (key: string, fallback?: string) => string;
  onChange: (next: Extract<Dimensions, { kind: 'trapezoidal' }>['leftSlope']) => void;
}) {
  const current =
    slope.mode === 'ratio'
      ? slope.value
      : slope.mode === 'angle'
        ? slope.degrees
        : fromMetres(slope.length, unit);

  return (
    <Card>
      <Text style={styles.slopeLabel}>{label}</Text>
      <Choice
        value={slope.mode}
        onChange={(mode) => {
          if (mode === 'ratio') onChange({ mode: 'ratio', value: 1 });
          else if (mode === 'angle') onChange({ mode: 'angle', degrees: 45 });
          else onChange({ mode: 'wettedLength', length: 0 });
        }}
        options={[
          { value: 'ratio' as const, label: t('measure.slopeMode.ratio') },
          { value: 'angle' as const, label: t('measure.slopeMode.angle') },
          { value: 'wettedLength' as const, label: t('measure.slopeMode.wettedLength') },
        ]}
      />
      <NumberField
        label={t(`measure.slopeMode.${slope.mode}`)}
        unit={slope.mode === 'angle' ? '°' : slope.mode === 'wettedLength' ? unit : undefined}
        value={current}
        decimals={4}
        onChange={(next) => {
          const value = next ?? 0;
          if (slope.mode === 'ratio') onChange({ mode: 'ratio', value });
          else if (slope.mode === 'angle') onChange({ mode: 'angle', degrees: value });
          else onChange({ mode: 'wettedLength', length: toMetres(value, unit) });
        }}
      />
    </Card>
  );
}

function LevelStep({
  draft,
  patchDraft,
  t,
  onNext,
  onCamera,
}: {
  draft: ReturnType<typeof useMeasurement>['draft'];
  patchDraft: ReturnType<typeof useMeasurement>['patchDraft'];
  t: (key: string, fallback?: string) => string;
  onNext: () => void;
  onCamera: () => void;
}) {
  const unit = draft.unit;
  const maximum = maximumDepth(draft.dimensions);

  return (
    <>
      <SectionTitle>{t('measure.step.level')}</SectionTitle>
      <Muted>{t('measure.depthHint')}</Muted>
      <Choice
        value={draft.levelMethod}
        onChange={(mode) => patchDraft({ levelMethod: mode })}
        options={[
          { value: 'manual' as const, label: t('measure.levelMethod.manual') },
          ...(draft.dimensions.kind === 'circular'
            ? [{ value: 'camera-assisted' as const, label: t('measure.levelMethod.camera') }]
            : []),
        ]}
      />
      <NumberField
        label={t('measure.depth')}
        unit={unit}
        value={draft.depth !== null ? fromMetres(draft.depth, unit) : null}
        decimals={4}
        invalid={draft.depth !== null && maximum !== null && draft.depth >= maximum}
        hint={
          maximum !== null
            ? `0 < h < ${formatNumber(fromMetres(maximum, unit), 3)} ${unit}`
            : undefined
        }
        onChange={(next) => {
          patchDraft({ depth: next === null ? null : toMetres(next, unit) });
        }}
      />
      {draft.levelMethod === 'camera-assisted' ? (
        <>
          <Note tone="warning">{t('level.camera.affineModelLimitation')}</Note>
          <Button label={t('level.camera.title')} variant="secondary" onPress={onCamera} />
        </>
      ) : null}
      <Button label={t('common.next')} onPress={onNext} disabled={draft.depth === null} />
    </>
  );
}

function VelocityStep({
  draft,
  patchDraft,
  t,
  hasAnalysis,
  onOpenVideo,
  onNext,
}: {
  draft: ReturnType<typeof useMeasurement>['draft'];
  patchDraft: ReturnType<typeof useMeasurement>['patchDraft'];
  t: (key: string, fallback?: string) => string;
  hasAnalysis: boolean;
  onOpenVideo: () => void;
  onNext: () => void;
}) {
  const materialOptions = useMemo(
    () => [
      ...ROUGHNESS_MATERIALS.map((material) => ({
        value: material.id,
        label: t(materialLabelKey(material.id)),
        detail: `n = ${material.n.toFixed(3)}  (${material.minN.toFixed(3)}–${material.maxN.toFixed(3)})`,
        group: t(`material.group.${material.group}`),
      })),
      { value: CUSTOM_ROUGHNESS_ID, label: t('material.custom') },
    ],
    [t]
  );
  const slopeUnit: SlopeUnit = draft.slopeUnit ?? 'permille';
  const slopeInUnit =
    draft.slopePermille === null
      ? null
      : slopeUnit === 'degrees'
        ? permilleToDegrees(draft.slopePermille)
        : draft.slopePermille;
  // Both readings of the same gradient, so switching units is never a guess.
  const slopeHint =
    draft.slopePermille === null
      ? 'S = ‰ / 1000'
      : `${formatNumber(draft.slopePermille, 3)} ‰ · ${formatNumber(permilleToDegrees(draft.slopePermille), 4)}° · S = ${formatNumber(draft.slopePermille / 1000, 6)}`;

  const selectedMaterial = findMaterial(draft.material);
  const roughnessOutsideBand =
    selectedMaterial !== null &&
    typeof draft.roughness === 'number' &&
    isOutsideBand(selectedMaterial, draft.roughness);

  const hasSurfaceVelocity = hasAnalysis || draft.surfaceVelocity !== undefined;

  return (
    <>
      <SectionTitle>{t('measure.step.velocity')}</SectionTitle>
      <Choice
        value={draft.method}
        onChange={(method: VelocityMethod) => patchDraft({ method })}
        options={[
          { value: 'video' as const, label: t('measure.method.video') },
          { value: 'manning' as const, label: t('measure.method.manning') },
          { value: 'manual' as const, label: t('measure.method.manual') },
        ]}
      />

      {draft.method === 'manning' ? (
        <>
          <Select
            label={t('measure.material')}
            value={draft.material ?? null}
            placeholder={t('measure.materialPlaceholder')}
            hint={t('measure.materialHint')}
            options={materialOptions}
            onChange={(id) => {
              const picked = findMaterial(id);
              patchDraft({ material: id, ...(picked ? { roughness: picked.n } : {}) });
            }}
          />
          <NumberField
            label={t('measure.roughness')}
            value={draft.roughness}
            hint={
              selectedMaterial
                ? `${t('measure.roughnessBand')}: ${selectedMaterial.minN.toFixed(3)}–${selectedMaterial.maxN.toFixed(3)}`
                : undefined
            }
            onChange={(next) => patchDraft({ roughness: next })}
          />
          {roughnessOutsideBand ? (
            <Note tone="warning">{t('measure.roughnessOutsideBand')}</Note>
          ) : null}
          <Choice
            label={t('measure.slopeUnitLabel')}
            value={slopeUnit}
            onChange={(next: SlopeUnit) => patchDraft({ slopeUnit: next })}
            options={[
              { value: 'permille' as const, label: t('measure.slopeUnit.permille') },
              { value: 'degrees' as const, label: t('measure.slopeUnit.degrees') },
            ]}
          />
          <NumberField
            label={t(`measure.slope.${slopeUnit}`)}
            unit={slopeUnit === 'degrees' ? '°' : '‰'}
            value={slopeInUnit}
            decimals={slopeUnit === 'degrees' ? 4 : 3}
            hint={slopeHint}
            onChange={(next) =>
              patchDraft({
                slopePermille:
                  next === null ? null : slopeUnit === 'degrees' ? degreesToPermille(next) : next,
              })
            }
          />
        </>
      ) : null}

      {draft.method === 'manual' ? (
        <NumberField
          label={t('measure.manualVelocity')}
          unit="m/s"
          value={draft.manualVelocity}
          onChange={(next) => patchDraft({ manualVelocity: next })}
        />
      ) : null}

      {draft.method === 'video' ? (
        <>
          <Badge label={t('video.experimentalBadge')} tone="experimental" />
          {hasSurfaceVelocity ? (
            <ValueRow
              label={t('video.surfaceVelocity')}
              value={formatNumber(draft.surfaceVelocity ?? null, 4)}
              unit="m/s"
              provenance={t('provenance.measuredVideo')}
            />
          ) : (
            <Note tone="warning">{t('measure.needVideoMeasurement')}</Note>
          )}
          <Button label={t('measure.openVideoVelocity')} onPress={onOpenVideo} variant="secondary" />
        </>
      ) : null}

      <Button
        label={t('common.next')}
        onPress={onNext}
        disabled={draft.method === 'video' && !hasSurfaceVelocity}
      />
    </>
  );
}

// ------------------------------------------------------------------ helpers

function defaultDimensionsFor(kind: Dimensions['kind']): Dimensions {
  switch (kind) {
    case 'circular':
      return { kind: 'circular', diameter: 0.3 };
    case 'rectangular':
      return { kind: 'rectangular', width: 0.5 };
    case 'trapezoidal':
      return {
        kind: 'trapezoidal',
        bottomWidth: 0.5,
        leftSlope: { mode: 'ratio', value: 1 },
        rightSlope: { mode: 'ratio', value: 1 },
      };
  }
}

function describeDimensions(dimensions: Dimensions): { label: string; value: string; unit?: string }[] {
  switch (dimensions.kind) {
    case 'circular':
      return [{ label: 'D', value: formatNumber(dimensions.diameter, 4), unit: 'm' }];
    case 'rectangular':
      return [
        { label: 'B', value: formatNumber(dimensions.width, 4), unit: 'm' },
        ...(dimensions.totalHeight !== undefined
          ? [{ label: 'H', value: formatNumber(dimensions.totalHeight, 4), unit: 'm' }]
          : []),
      ];
    case 'trapezoidal':
      return [
        { label: 'b', value: formatNumber(dimensions.bottomWidth, 4), unit: 'm' },
        { label: 'zL', value: describeSlopeShort(dimensions.leftSlope) },
        { label: 'zR', value: describeSlopeShort(dimensions.rightSlope) },
      ];
  }
}

function describeSlopeShort(slope: Extract<Dimensions, { kind: 'trapezoidal' }>['leftSlope']): string {
  if (slope.mode === 'ratio') return `z=${formatNumber(slope.value, 3)}`;
  if (slope.mode === 'angle') return `${formatNumber(slope.degrees, 1)}°`;
  return `L=${formatNumber(slope.length, 3)} m`;
}


const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  stepLabel: { ...typography.small, color: colors.textFaint, letterSpacing: 1 },
  stepLabelActive: { color: colors.accent, fontWeight: '700' },
  stepLabelDone: { color: colors.textMuted },
  siteName: { ...typography.body, color: colors.text, fontWeight: '700' },
  slopeLabel: { ...typography.small, color: colors.textMuted, letterSpacing: 0.6 },
});
