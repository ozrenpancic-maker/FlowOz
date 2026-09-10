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
