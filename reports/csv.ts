import type { SavedMeasurement } from '../domain/measurement';
import { classifyAccuracy } from '../domain/gps';
import type { CsvFormat } from '../storage/settings';

/**
 * CSV export in two dialects:
 *  - `international`: comma separator, decimal point.
 *  - `excel`:         semicolon separator, decimal comma (what a Croatian
 *                     Excel install opens correctly by double-click).
 *
 * All numeric columns are SI. A withheld value is an empty cell, never 0.
 */

export interface CsvDialect {
  delimiter: string;
  decimalSeparator: '.' | ',';
  lineEnding: string;
}

export const CSV_DIALECTS: Record<CsvFormat, CsvDialect> = {
  international: { delimiter: ',', decimalSeparator: '.', lineEnding: '\r\n' },
  excel: { delimiter: ';', decimalSeparator: ',', lineEnding: '\r\n' },
};

export const CSV_COLUMNS = [
  'id',
  'display_id',
  'created_at_iso',
  'site_name',
  'geometry',
  'depth_m',
  'area_m2',
  'wetted_perimeter_m',
  'hydraulic_radius_m',
  'top_width_m',
  'fill_ratio',
  'method',
  'roughness_n',
  'slope',
  'surface_velocity_ms',
  'alpha',
  'mean_velocity_ms',
  'flow_m3s',
  'flow_ls',
  'level_method',
  'processing_status',
  'confidence',
  'geometry_quality',
  'level_quality',
  'velocity_quality',
  'uncertainty',
  'gps_latitude',
  'gps_longitude',
  'gps_accuracy_m',
  'gps_class',
  'video_source',
  'accepted_vectors',
  'total_vectors',
  'calibration_status',
  'algorithm_version',
  'measurement_version',
  'notes',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

function formatCell(value: string | number | null | undefined, dialect: CsvDialect): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const text = String(value);
    return dialect.decimalSeparator === ',' ? text.replace('.', ',') : text;
  }
  return value;
}

/**
 * Escape a cell per RFC 4180: wrap in quotes when it contains the delimiter, a
 * quote, or a line break, and double any embedded quote.
 */
export function escapeCell(raw: string, dialect: CsvDialect): string {
  const needsQuoting =
    raw.includes(dialect.delimiter) || raw.includes('"') || raw.includes('\n') || raw.includes('\r');
  if (!needsQuoting) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

export function measurementRow(measurement: SavedMeasurement): Record<CsvColumn, string | number | null> {
  const analysis = measurement.videoAnalysis;
  return {
    id: measurement.id,
    display_id: measurement.displayId ?? '',
    created_at_iso: measurement.createdAt,
    site_name: measurement.siteName ?? '',
    geometry: measurement.geometry,
    depth_m: measurement.depth,
    area_m2: measurement.area ?? null,
    wetted_perimeter_m: measurement.wettedPerimeter ?? null,
    hydraulic_radius_m: measurement.hydraulicRadius ?? null,
    top_width_m: measurement.topWidth ?? null,
    fill_ratio: measurement.fillRatio ?? null,
    method: measurement.method,
    roughness_n: measurement.roughness ?? null,
    slope: measurement.slope ?? null,
    surface_velocity_ms: measurement.surfaceVelocity ?? null,
    alpha: measurement.alpha ?? null,
    mean_velocity_ms: measurement.velocity ?? null,
    flow_m3s: measurement.flowM3s ?? null,
    flow_ls: typeof measurement.flowM3s === 'number' ? measurement.flowM3s * 1000 : null,
    level_method: measurement.levelMethod,
    processing_status: measurement.processingStatus,
    confidence: measurement.confidence,
    geometry_quality: measurement.dataQuality.geometry.grade,
    level_quality: measurement.dataQuality.level.grade,
    velocity_quality: measurement.dataQuality.velocity.grade,
    uncertainty: measurement.dataQuality.uncertainty,
    gps_latitude: measurement.location?.latitude ?? null,
    gps_longitude: measurement.location?.longitude ?? null,
    gps_accuracy_m: measurement.location?.accuracy ?? null,
    gps_class: measurement.location ? classifyAccuracy(measurement.location.accuracy) : '',
    video_source: measurement.videoSource ?? '',
    accepted_vectors: analysis?.quality.acceptedVectors ?? null,
    total_vectors: analysis?.quality.totalVectors ?? null,
    calibration_status: analysis?.calibrationStatus ?? '',
    algorithm_version: measurement.algorithmVersion,
    measurement_version: measurement.measurementVersion,
    notes: measurement.notes ?? '',
  };
}

export function toCsv(measurements: readonly SavedMeasurement[], format: CsvFormat): string {
  const dialect = CSV_DIALECTS[format];
  const lines: string[] = [];

  lines.push(CSV_COLUMNS.map((column) => escapeCell(column, dialect)).join(dialect.delimiter));

  for (const measurement of measurements) {
    const row = measurementRow(measurement);
    lines.push(
      CSV_COLUMNS.map((column) => escapeCell(formatCell(row[column], dialect), dialect)).join(
        dialect.delimiter
      )
    );
  }

  return lines.join(dialect.lineEnding) + dialect.lineEnding;
}
