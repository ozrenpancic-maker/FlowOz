import { buildReportModel, collectionFileName, exportFileName } from '../../reports/report-model';
import { CSV_COLUMNS, CSV_DIALECTS, escapeCell, measurementRow, toCsv } from '../../reports/csv';
import { escapeHtml, renderReportHtml } from '../../reports/pdf';
import { DEFAULT_SETTINGS } from '../../storage/settings';
import { UNCERTAINTY_WITHHELD } from '../../domain/quality';
import { translate } from '../../state/i18n';
import { makeMeasurement } from '../storage/fixtures';

/** Minimal RFC 4180 reader, so the escaping is checked by actually re-reading it. */
function parseCsvRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (quoted) {
      if (character === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current);
  return cells;
}

const t = (key: string, fallback?: string) => translate('en', key, fallback);
const measurement = makeMeasurement('m-report');

describe('report model', () => {
  it('covers every section the specification requires', () => {
    const model = buildReportModel(measurement, DEFAULT_SETTINGS, '2026-09-10T13:00:00.000Z');
    const titles = model.sections.map((section) => section.titleKey);
    expect(titles).toEqual(
      expect.arrayContaining([
        'report.section.identity',
        'report.section.geometry',
        'report.section.hydraulics',
        'report.section.method',
        'report.section.result',
        'report.section.quality',
      ])
    );
    expect(model.algorithmVersion).toBe(measurement.algorithmVersion);
    expect(model.measurementVersion).toBe(measurement.measurementVersion);
    expect(model.processingStatus).toBe(measurement.processingStatus);
    expect(model.disclaimerKeys.length).toBeGreaterThan(0);
  });

  it('states the uncertainty as withheld, not as a number', () => {
    const model = buildReportModel(measurement, DEFAULT_SETTINGS);
    const row = model.sections
      .flatMap((section) => section.rows)
      .find((entry) => entry.labelKey === 'report.uncertainty');
    expect(row?.value).toBe(UNCERTAINTY_WITHHELD);
    expect(row?.withheld).toBe(true);
  });

  it('renders a missing value as WITHHELD rather than 0', () => {
    const withheld = { ...measurement };
    delete (withheld as { flowM3s?: number }).flowM3s;

    const model = buildReportModel(withheld, DEFAULT_SETTINGS);
    const flow = model.sections
      .flatMap((section) => section.rows)
      .find((entry) => entry.labelKey === 'report.flowM3s');
    expect(flow?.value).toBe('WITHHELD');
    expect(flow?.withheld).toBe(true);
    expect(flow?.value).not.toBe('0');
  });

  it('warns about an assumed alpha on a video measurement', () => {
    const video = {
      ...makeMeasurement('m-video', { method: 'video', surfaceVelocity: 1.1 }),
      alpha: 0.85,
    };
    const model = buildReportModel(video, DEFAULT_SETTINGS);
    const keys = model.warnings.map((warning) => warning.messageKey);
    expect(keys).toContain('report.warning.videoExperimental');
    expect(keys).toContain('report.warning.alphaAssumed');
  });

  it('adds a compact acquisition section only when a sensor snapshot exists, and only for fields actually captured', () => {
    const withoutSnapshot = buildReportModel(measurement, DEFAULT_SETTINGS);
    expect(withoutSnapshot.sections.map((s) => s.titleKey)).not.toContain('report.section.acquisition');

    const withSnapshot = {
      ...makeMeasurement('m-acq', {
        sensorSnapshot: {
          timestamp: Date.now(),
          device: { model: 'Pixel 8', appVersion: '1.0.1', algorithmVersion: 'ssiv-1.0.0' },
          camera: {
            available: true,
            facing: 'back' as const,
            sourceWidth: 1280,
            sourceHeight: 720,
            intrinsicsAvailable: false,
            distortionAvailable: false,
          },
          motion: {
            accelerometerAvailable: true,
            gyroscopeAvailable: true,
            deviceMotionAvailable: true,
            pitchDeg: 30,
            rollDeg: 1,
          },
        },
      }),
    };
    const model = buildReportModel(withSnapshot, DEFAULT_SETTINGS);
    const acquisition = model.sections.find((s) => s.titleKey === 'report.section.acquisition');
    expect(acquisition).toBeDefined();
    const labels = acquisition?.rows.map((r) => r.labelKey) ?? [];
    expect(labels).toContain('report.acquisitionDevice');
    expect(labels).toContain('report.acquisitionOrientation');
    // No image-quality evidence was on this snapshot, so no row is invented for it.
    expect(labels).not.toContain('report.acquisitionImageQuality');

    const disabled = buildReportModel(withSnapshot, { ...DEFAULT_SETTINGS, pdfIncludeAcquisition: false });
    expect(disabled.sections.map((s) => s.titleKey)).not.toContain('report.section.acquisition');
  });

  it('honours the GPS and method-detail settings', () => {
    const located = {
      ...measurement,
      location: { latitude: 45.815, longitude: 15.9819, accuracy: 4, timestamp: 0 },
    };

    const withGps = buildReportModel(located, DEFAULT_SETTINGS);
    expect(withGps.sections.map((s) => s.titleKey)).toContain('report.section.location');

    const withoutGps = buildReportModel(located, { ...DEFAULT_SETTINGS, pdfIncludeGps: false });
    expect(withoutGps.sections.map((s) => s.titleKey)).not.toContain('report.section.location');

    const lean = buildReportModel(measurement, { ...DEFAULT_SETTINGS, pdfIncludeMethodDetails: false });
    const methodRows = lean.sections.find((s) => s.titleKey === 'report.section.method')?.rows ?? [];
    expect(methodRows.map((r) => r.labelKey)).not.toContain('report.roughness');
  });
});

describe('file names', () => {
  it('are deterministic for the same measurement', () => {
    expect(exportFileName(measurement, 'pdf')).toBe(exportFileName(measurement, 'pdf'));
    expect(exportFileName(measurement, 'pdf')).toMatch(/^FLOWVISION-FV-M-REPORT-\d{8}T\d{6}Z\.pdf$/);
    expect(exportFileName(measurement, 'csv')).toMatch(/\.csv$/);
  });

  it('strip characters a file system would reject', () => {
    const awkward = { ...measurement, displayId: 'FV/../weird name*?' };
    const name = exportFileName(awkward, 'csv');
    expect(name).not.toMatch(/[/*?\s]/);
  });

  it('name a collection export by its generation time', () => {
    expect(collectionFileName('csv', '2026-09-10T13:00:00.000Z')).toBe(
      'FLOWVISION-measurements-20260910T130000Z.csv'
    );
  });
});

describe('CSV export', () => {
  it('uses comma and decimal point in the international dialect', () => {
    const csv = toCsv([measurement], 'international');
    const [header, row] = csv.split('\r\n');
    expect(header?.split(',')).toHaveLength(CSV_COLUMNS.length);
    expect(row).toContain('.');
    expect(row?.split(',')[0]).toBe('m-report');
  });

  it('uses semicolon and decimal comma in the Excel dialect', () => {
    const csv = toCsv([measurement], 'excel');
    const row = csv.split('\r\n')[1] ?? '';
    const cells = row.split(';');
    expect(cells).toHaveLength(CSV_COLUMNS.length);
    // The depth is a decimal, and in this dialect it uses a comma.
    const depthIndex = CSV_COLUMNS.indexOf('depth_m');
    expect(cells[depthIndex]).toContain(',');
    expect(cells[depthIndex]).not.toContain('.');
  });

  it('leaves a withheld value as an empty cell, never as 0', () => {
    const withheld = { ...measurement };
    delete (withheld as { flowM3s?: number }).flowM3s;

    const row = measurementRow(withheld);
    expect(row.flow_m3s).toBeNull();
    expect(row.flow_ls).toBeNull();

    const cells = (toCsv([withheld], 'international').split('\r\n')[1] ?? '').split(',');
    expect(cells[CSV_COLUMNS.indexOf('flow_m3s')]).toBe('');
  });

  it('escapes delimiters, quotes and newlines per RFC 4180', () => {
    const international = CSV_DIALECTS.international;
    expect(escapeCell('plain', international)).toBe('plain');
    expect(escapeCell('a,b', international)).toBe('"a,b"');
    expect(escapeCell('say "hi"', international)).toBe('"say ""hi"""');
    expect(escapeCell('line\nbreak', international)).toBe('"line\nbreak"');
    // A comma needs no quoting when the delimiter is a semicolon.
    expect(escapeCell('a,b', CSV_DIALECTS.excel)).toBe('a,b');
    expect(escapeCell('a;b', CSV_DIALECTS.excel)).toBe('"a;b"');
  });

  it('keeps a note containing the delimiter in one cell', () => {
    const noted = { ...measurement, notes: 'foam, debris; heavy "chunks"' };
    for (const format of ['international', 'excel'] as const) {
      const row = toCsv([noted], format).split('\r\n')[1] ?? '';
      const cells = parseCsvRow(row, CSV_DIALECTS[format].delimiter);
      expect(cells).toHaveLength(CSV_COLUMNS.length);
      expect(cells[CSV_COLUMNS.indexOf('notes')]).toBe(noted.notes);
    }
  });

  it('carries the SI columns and the quality columns', () => {
    expect(CSV_COLUMNS).toEqual(expect.arrayContaining(['depth_m', 'area_m2', 'flow_m3s', 'mean_velocity_ms']));
    expect(CSV_COLUMNS).toEqual(expect.arrayContaining(['confidence', 'uncertainty', 'processing_status']));
    expect(measurementRow(measurement).uncertainty).toBe(UNCERTAINTY_WITHHELD);
  });

  it('leaves the acquisition columns empty, not zero, when there is no sensor snapshot', () => {
    const row = measurementRow(measurement);
    for (const column of [
      'camera_width_px',
      'camera_height_px',
      'zoom',
      'nominal_fps',
      'actual_fps',
      'delta_t_s',
      'streamwise_velocity_m_s',
      'lateral_velocity_m_s',
      'speed_magnitude_m_s',
      'cross_flow_ratio',
      'ssiv_snr',
      'pitch_deg',
      'roll_deg',
      'angular_velocity_rms_deg_s',
      'acceleration_rms_m_s2',
      'image_mean_luminance',
      'saturated_pixel_fraction',
      'blur_score',
      'glare_score',
    ] as const) {
      expect(row[column]).toBeNull();
    }
    expect(row.camera_lens).toBe('');
    expect(row.timing_source).toBe('');
    const cells = (toCsv([measurement], 'international').split('\r\n')[1] ?? '').split(',');
    expect(cells[CSV_COLUMNS.indexOf('pitch_deg')]).toBe('');
    expect(cells[CSV_COLUMNS.indexOf('timing_source')]).toBe('');
  });

  it('populates the acquisition columns from a real sensor snapshot', () => {
    const withSnapshot = {
      ...makeMeasurement('m-csv-acq', {
        sensorSnapshot: {
          timestamp: Date.now(),
          device: { appVersion: '1.0.1', algorithmVersion: 'ssiv-1.0.0' },
          camera: {
            available: true,
            facing: 'back' as const,
            sourceWidth: 1280,
            sourceHeight: 720,
            nominalFps: 30,
            actualFps: 29.7,
            intrinsicsAvailable: false,
            distortionAvailable: false,
          },
          motion: {
            accelerometerAvailable: true,
            gyroscopeAvailable: true,
            deviceMotionAvailable: true,
            pitchDeg: 30,
            rollDeg: 1,
            angularVelocityRmsDegPerSec: 0.2,
            accelerationRmsMps2: 0.15,
          },
          imageQuality: {
            meanLuminance: 120,
            darkPixelFraction: 0.1,
            saturatedPixelFraction: 0.02,
            localContrast: 8,
            blurScore: 25,
            glareScore: 0.01,
            sampleWidth: 240,
            sampleHeight: 135,
          },
        },
      }),
    };
    const row = measurementRow(withSnapshot);
    expect(row.camera_lens).toBe('back');
    expect(row.camera_width_px).toBe(1280);
    expect(row.camera_height_px).toBe(720);
    expect(row.nominal_fps).toBe(30);
    expect(row.actual_fps).toBe(29.7);
    expect(row.pitch_deg).toBe(30);
    expect(row.roll_deg).toBe(1);
    expect(row.angular_velocity_rms_deg_s).toBe(0.2);
    expect(row.acceleration_rms_m_s2).toBe(0.15);
    expect(row.image_mean_luminance).toBe(120);
    expect(row.saturated_pixel_fraction).toBe(0.02);
    expect(row.blur_score).toBe(25);
    expect(row.glare_score).toBe(0.01);
  });

  it('emits a header even for an empty collection', () => {
    const csv = toCsv([], 'international');
    expect(csv.split('\r\n')[0]?.split(',')).toHaveLength(CSV_COLUMNS.length);
  });
});

describe('PDF rendering', () => {
  it('escapes HTML so operator text cannot break the report', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
    expect(escapeHtml("O'Brien & Co")).toBe('O&#39;Brien &amp; Co');
  });

  it('renders every required element of the technical report', () => {
    const model = buildReportModel(measurement, DEFAULT_SETTINGS, '2026-09-10T13:00:00.000Z');
    const html = renderReportHtml(model, t);

    expect(html).toContain('FLOWVISION');
    expect(html).toContain(model.displayId);
    expect(html).toContain(measurement.createdAt);
    expect(html).toContain(measurement.algorithmVersion);
    expect(html).toContain(measurement.processingStatus);
    expect(html).toContain(UNCERTAINTY_WITHHELD);
    expect(html).toContain(t('report.disclaimer.fieldEstimate'));
    expect(html).toContain(t('report.area'));
  });

  it('marks a withheld value visibly rather than printing a number', () => {
    const withheld = { ...measurement };
    delete (withheld as { flowM3s?: number }).flowM3s;
    const html = renderReportHtml(buildReportModel(withheld, DEFAULT_SETTINGS), t);
    expect(html).toContain('class="withheld"');
    expect(html).toContain('WITHHELD');
  });

  it('renders operator notes as text, not as markup', () => {
    const noted = { ...measurement, notes: '<b>bold</b>' };
    const model = buildReportModel(noted, DEFAULT_SETTINGS);
    model.warnings.push({ messageKey: '<b>bold</b>' });
    const html = renderReportHtml(model, t);
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('renders in Croatian when given the Croatian translator', () => {
    const model = buildReportModel(measurement, DEFAULT_SETTINGS);
    const html = renderReportHtml(model, (key, fallback) => translate('hr', key, fallback));
    expect(html).toContain('Omočena površina A');
    expect(html).toContain('Tehnički izvještaj');
  });
});
