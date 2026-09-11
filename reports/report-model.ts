import type { SavedMeasurement } from '../domain/measurement';
import { UNCERTAINTY_WITHHELD } from '../domain/quality';
import { formatNumber } from '../domain/units';
import { classifyAccuracy } from '../domain/gps';
import { materialLabelKey } from '../domain/roughness';
import { toCubicMetresPerHour, toLitresPerSecond } from '../domain/hydraulics';
import { classifyStability } from '../domain/sensor-snapshot';
import { gradeContrast, gradeExposure, gradeGlare, gradeSharpness } from '../video/image-quality';
import type { AppSettings } from '../storage/settings';

/**
 * Language-neutral report model.
 *
 * Both exporters build from this one structure, so the PDF and the CSV can
 * never disagree about what a measurement says. Values that are withheld carry
 * `withheld: true` and are rendered as WITHHELD — never as 0.
 */

export interface ReportValue {
  labelKey: string;
  value: string;
  /** When set, `value` is a translation key rather than literal text. */
  valueKey?: string;
  unit?: string;
  provenanceKey?: string;
  qualityKey?: string;
  withheld?: boolean;
  /** Rendered in a warning style. */
  warning?: boolean;
}

export interface ReportSection {
  titleKey: string;
  rows: ReportValue[];
}

export interface ReportModel {
  measurementId: string;
  displayId: string;
  createdAt: string;
  siteName?: string;
  sections: ReportSection[];
  warnings: { messageKey: string; detail?: string }[];
  disclaimerKeys: string[];
  algorithmVersion: string;
  measurementVersion: number;
  processingStatus: string;
  generatedAt: string;
}

const WITHHELD = 'WITHHELD';

function numberRow(
  labelKey: string,
  value: number | undefined | null,
  decimals: number,
  unit?: string,
  provenanceKey?: string
): ReportValue {
  const isPresent = typeof value === 'number' && Number.isFinite(value);
  return {
    labelKey,
    value: isPresent ? formatNumber(value, decimals) : WITHHELD,
    ...(unit ? { unit } : {}),
    ...(provenanceKey ? { provenanceKey } : {}),
    ...(isPresent ? {} : { withheld: true }),
  };
}

function dimensionRows(measurement: SavedMeasurement): ReportValue[] {
  const rows: ReportValue[] = [];
  const dimensions = measurement.dimensions;
  switch (dimensions.kind) {
    case 'circular':
      rows.push(numberRow('report.diameter', dimensions.diameter, 4, 'm', 'provenance.site'));
      rows.push(numberRow('report.fillRatio', measurement.fillRatio, 3));
      break;
    case 'rectangular':
      rows.push(numberRow('report.width', dimensions.width, 4, 'm'));
      if (typeof dimensions.totalHeight === 'number') {
        rows.push(numberRow('report.totalHeight', dimensions.totalHeight, 4, 'm'));
      }
      break;
    case 'trapezoidal':
      rows.push(numberRow('report.bottomWidth', dimensions.bottomWidth, 4, 'm'));
      rows.push({
        labelKey: 'report.sideSlopes',
        value: `${describeSlope(dimensions.leftSlope)} / ${describeSlope(dimensions.rightSlope)}`,
      });
      break;
  }
  return rows;
}

function describeSlope(slope: { mode: string; value?: number; degrees?: number; length?: number }): string {
  if (slope.mode === 'ratio') return `z=${formatNumber(slope.value ?? null, 3)}`;
  if (slope.mode === 'angle') return `${formatNumber(slope.degrees ?? null, 1)}°`;
  return `L=${formatNumber(slope.length ?? null, 3)} m`;
}

export function buildReportModel(
  measurement: SavedMeasurement,
  settings: AppSettings,
  generatedAt = new Date().toISOString()
): ReportModel {
  const sections: ReportSection[] = [];

  sections.push({
    titleKey: 'report.section.identity',
    rows: [
      { labelKey: 'report.measurementId', value: measurement.displayId ?? measurement.id },
      { labelKey: 'report.createdAt', value: measurement.createdAt },
      ...(measurement.siteName ? [{ labelKey: 'report.site', value: measurement.siteName }] : []),
      { labelKey: 'report.processingStatus', value: measurement.processingStatus },
    ],
  });

  sections.push({
    titleKey: 'report.section.geometry',
    rows: [
      { labelKey: 'report.geometryKind', value: measurement.geometry },
      ...dimensionRows(measurement),
      numberRow('report.depth', measurement.depth, 4, 'm', `provenance.${measurement.provenance.depth.toLowerCase()}`),
      { labelKey: 'report.levelMethod', value: measurement.levelMethod },
    ],
  });

  sections.push({
    titleKey: 'report.section.hydraulics',
    rows: [
      numberRow('report.area', measurement.area, 5, 'm²', 'provenance.calculated'),
      numberRow('report.wettedPerimeter', measurement.wettedPerimeter, 4, 'm', 'provenance.calculated'),
      numberRow('report.hydraulicRadius', measurement.hydraulicRadius, 5, 'm', 'provenance.calculated'),
      numberRow('report.topWidth', measurement.topWidth, 4, 'm', 'provenance.calculated'),
    ],
  });

  const methodRows: ReportValue[] = [{ labelKey: 'report.method', value: measurement.method }];
  if (settings.pdfIncludeMethodDetails) {
    if (measurement.method === 'manning') {
      if (measurement.material) {
        methodRows.push({
          labelKey: 'report.material',
          value: measurement.material,
          valueKey: materialLabelKey(measurement.material),
        });
      }
      methodRows.push(numberRow('report.roughness', measurement.roughness, 4));
      methodRows.push(numberRow('report.slope', measurement.slope, 6));
    }
    if (measurement.method === 'video') {
      methodRows.push(
        numberRow(
          'report.surfaceVelocity',
          measurement.surfaceVelocity,
          4,
          'm/s',
          'provenance.measuredVideo'
        )
      );
      if (measurement.videoAnalysis) {
        methodRows.push({
          labelKey: 'report.velocitySource',
          value: measurement.videoAnalysis.velocitySource,
          valueKey: `video.velocitySource.${measurement.videoAnalysis.velocitySource}`,
        });
      }
      methodRows.push(
        numberRow(
          'report.alpha',
          measurement.alpha,
          3,
          undefined,
          `provenance.${measurement.provenance.alpha.toLowerCase()}`
        )
      );
      const analysis = measurement.videoAnalysis;
      if (analysis) {
        methodRows.push({
          labelKey: 'report.acceptedVectors',
          value: `${analysis.quality.acceptedVectors}/${analysis.quality.totalVectors} (${Math.round(
            analysis.quality.acceptanceRatio * 100
          )}%)`,
        });
        methodRows.push({
          labelKey: 'report.stablePairs',
          value: `${analysis.quality.stablePairs}/${analysis.quality.totalPairs}`,
        });
        methodRows.push({ labelKey: 'report.calibrationStatus', value: analysis.calibrationStatus });
        methodRows.push(
          numberRow('report.cameraCompensation', analysis.quality.cameraCompensationPx, 2, 'px')
        );
      }
      if (measurement.perspectiveScale) {
        methodRows.push(numberRow('report.roiWidth', measurement.perspectiveScale.widthM, 3, 'm'));
        methodRows.push(numberRow('report.roiLength', measurement.perspectiveScale.lengthM, 3, 'm'));
      }
      if (measurement.lateralProfileFlowM3s !== undefined) {
        methodRows.push({
          labelKey: 'report.lateralProfileFlow',
          value:
            `${formatNumber(measurement.lateralProfileFlowM3s, 5)} m³/s ` +
            `(${measurement.lateralProfileColumnsUsed ?? 0}/${measurement.lateralProfileColumnsTotal ?? 0} ` +
            `columns)`,
        });
      }
    }
  }
  methodRows.push(
    numberRow('report.meanVelocity', measurement.velocity, 4, 'm/s', 'provenance.calculated')
  );
  sections.push({ titleKey: 'report.section.method', rows: methodRows });

  const flowRows: ReportValue[] = [
    numberRow('report.flowM3s', measurement.flowM3s, 5, 'm³/s', 'provenance.calculated'),
    numberRow(
      'report.flowLs',
      typeof measurement.flowM3s === 'number' ? toLitresPerSecond(measurement.flowM3s) : undefined,
      2,
      'l/s',
      'provenance.calculated'
    ),
    numberRow(
      'report.flowM3h',
      typeof measurement.flowM3s === 'number'
        ? toCubicMetresPerHour(measurement.flowM3s)
        : undefined,
      2,
      'm³/h',
      'provenance.calculated'
    ),
    {
      labelKey: 'report.overallQuality',
      value: measurement.dataQuality.overall.grade,
      qualityKey: measurement.dataQuality.overall.reasonKey,
    },
    { labelKey: 'report.uncertainty', value: UNCERTAINTY_WITHHELD, withheld: true },
  ];
  sections.push({ titleKey: 'report.section.result', rows: flowRows });

  sections.push({
    titleKey: 'report.section.quality',
    rows: [
      {
        labelKey: 'report.geometryQuality',
        value: measurement.dataQuality.geometry.grade,
        qualityKey: measurement.dataQuality.geometry.reasonKey,
      },
      {
        labelKey: 'report.levelQuality',
        value: measurement.dataQuality.level.grade,
        qualityKey: measurement.dataQuality.level.reasonKey,
      },
      {
        labelKey: 'report.velocityQuality',
        value: measurement.dataQuality.velocity.grade,
        qualityKey: measurement.dataQuality.velocity.reasonKey,
      },
      ...(measurement.dataQuality.cameraStability
        ? [
            {
              labelKey: 'report.cameraStabilityQuality',
              value: measurement.dataQuality.cameraStability.grade,
              qualityKey: measurement.dataQuality.cameraStability.reasonKey,
            },
          ]
        : []),
      ...(measurement.dataQuality.imageQuality
        ? [
            {
              labelKey: 'report.imageQualityGrade',
              value: measurement.dataQuality.imageQuality.grade,
              qualityKey: measurement.dataQuality.imageQuality.reasonKey,
            },
          ]
        : []),
    ],
  });

  if (settings.pdfIncludeGps && measurement.location) {
    sections.push({
      titleKey: 'report.section.location',
      rows: [
        numberRow('report.latitude', measurement.location.latitude, 6, '°'),
        numberRow('report.longitude', measurement.location.longitude, 6, '°'),
        numberRow('report.gpsAccuracy', measurement.location.accuracy, 1, 'm'),
        { labelKey: 'report.gpsClass', value: classifyAccuracy(measurement.location.accuracy) },
      ],
    });
  }

  // Compact by design (Phase 16): only fields that were actually captured —
  // never a row invented to look complete. Kept out of the main result page,
  // a section of its own the operator can skip entirely via settings.
  if (settings.pdfIncludeAcquisition && measurement.sensorSnapshot) {
    const snapshot = measurement.sensorSnapshot;
    const rows: ReportValue[] = [];
    if (snapshot.device.model) rows.push({ labelKey: 'report.acquisitionDevice', value: snapshot.device.model });
    if (snapshot.camera.facing) {
      rows.push({ labelKey: 'report.acquisitionCamera', value: snapshot.camera.facing });
    }
    if (snapshot.camera.sourceWidth && snapshot.camera.sourceHeight) {
      rows.push({
        labelKey: 'report.acquisitionResolution',
        value: `${snapshot.camera.sourceWidth}×${snapshot.camera.sourceHeight}`,
      });
    }
    if (snapshot.camera.nominalFps !== undefined || snapshot.camera.actualFps !== undefined) {
      rows.push({
        labelKey: 'report.acquisitionFps',
        value:
          `${snapshot.camera.nominalFps !== undefined ? formatNumber(snapshot.camera.nominalFps, 1) : WITHHELD} nominal / ` +
          `${snapshot.camera.actualFps !== undefined ? formatNumber(snapshot.camera.actualFps, 1) : WITHHELD} actual`,
      });
    }
    if (snapshot.motion.pitchDeg !== undefined || snapshot.motion.rollDeg !== undefined) {
      rows.push({
        labelKey: 'report.acquisitionOrientation',
        value:
          `pitch ${snapshot.motion.pitchDeg !== undefined ? formatNumber(snapshot.motion.pitchDeg, 1) : WITHHELD}° / ` +
          `roll ${snapshot.motion.rollDeg !== undefined ? formatNumber(snapshot.motion.rollDeg, 1) : WITHHELD}°`,
      });
    }
    if (
      snapshot.motion.angularVelocityRmsDegPerSec !== undefined ||
      snapshot.motion.accelerationRmsMps2 !== undefined
    ) {
      rows.push({
        labelKey: 'report.acquisitionStability',
        value: classifyStability(snapshot.motion.angularVelocityRmsDegPerSec, snapshot.motion.accelerationRmsMps2),
      });
    }
    if (snapshot.imageQuality) {
      rows.push({
        labelKey: 'report.acquisitionImageQuality',
        value:
          `exposure ${gradeExposure(snapshot.imageQuality)}, contrast ${gradeContrast(snapshot.imageQuality)}, ` +
          `sharpness ${gradeSharpness(snapshot.imageQuality)}, glare ${gradeGlare(snapshot.imageQuality)}`,
      });
    }
    if (measurement.location?.accuracy !== undefined) {
      rows.push(numberRow('report.acquisitionGpsAccuracy', measurement.location.accuracy, 1, 'm'));
    }
    if (rows.length > 0) {
      sections.push({ titleKey: 'report.section.acquisition', rows });
    }
  }

  const warnings: ReportModel['warnings'] = [];
  for (const finding of measurement.raw.plausibility.advisories) {
    warnings.push({ messageKey: finding.messageKey, detail: `${finding.field}=${finding.value}` });
  }
  if (measurement.method === 'video') {
    warnings.push({ messageKey: 'report.warning.videoExperimental' });
  }
  if (measurement.levelMethod === 'camera-assisted') {
    warnings.push({ messageKey: 'report.warning.cameraLevelNotValidated' });
  }
  if (measurement.provenance.alpha === 'ASSUMED') {
    warnings.push({ messageKey: 'report.warning.alphaAssumed' });
  }
  if (measurement.processingStatus !== 'PROCESSED') {
    warnings.push({
      messageKey: 'report.warning.notProcessed',
      detail: measurement.processingStatus,
    });
  }

  return {
    measurementId: measurement.id,
    displayId: measurement.displayId ?? measurement.id,
    createdAt: measurement.createdAt,
    ...(measurement.siteName ? { siteName: measurement.siteName } : {}),
    sections,
    warnings,
    disclaimerKeys: [
      'report.disclaimer.fieldEstimate',
      'report.disclaimer.noTraceableValidation',
      'report.disclaimer.uncertaintyWithheld',
    ],
    algorithmVersion: measurement.algorithmVersion,
    measurementVersion: measurement.measurementVersion,
    processingStatus: measurement.processingStatus,
    generatedAt,
  };
}

/**
 * Deterministic export file name: the same measurement always produces the same
 * name, so a re-export overwrites rather than littering the device.
 */
export function exportFileName(measurement: SavedMeasurement, extension: 'pdf' | 'csv'): string {
  const stamp = measurement.createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const id = (measurement.displayId ?? measurement.id).replace(/[^A-Za-z0-9_-]/g, '');
  return `FLOWVISION-${id}-${stamp}.${extension}`;
}

export function collectionFileName(extension: 'csv', at: string): string {
  const stamp = at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `FLOWVISION-measurements-${stamp}.${extension}`;
}
