import * as Print from 'expo-print';

import type { ReportModel, ReportValue } from './report-model';

/** Translator injected by the caller, so this module stays language-agnostic. */
export type Translate = (key: string, fallback?: string) => string;

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRow(row: ReportValue, t: Translate): string {
  const label = escapeHtml(t(row.labelKey, row.labelKey));
  const text = row.valueKey ? t(row.valueKey, row.value) : row.value;
  const value = escapeHtml(row.unit ? `${text} ${row.unit}` : text);
  const provenance = row.provenanceKey ? escapeHtml(t(row.provenanceKey, row.provenanceKey)) : '';
  const quality = row.qualityKey ? escapeHtml(t(row.qualityKey, row.qualityKey)) : '';
  const classes = [row.withheld ? 'withheld' : '', row.warning ? 'warning' : ''].filter(Boolean).join(' ');

  return `<tr class="${classes}">
    <td class="label">${label}</td>
    <td class="value">${value}</td>
    <td class="meta">${provenance}${provenance && quality ? ' · ' : ''}${quality}</td>
  </tr>`;
}

/**
 * Render the technical report.
 *
 * Everything the specification requires is on the page: identity, geometry,
 * hydraulics, method, α, sources, quality, processing status, warnings,
 * algorithm version and the disclaimer. Withheld values are printed as WITHHELD
 * in a distinct style so a printed report cannot be read as a completed one.
 */
export function renderReportHtml(model: ReportModel, t: Translate): string {
  const sections = model.sections
    .map(
      (section) => `<section>
        <h2>${escapeHtml(t(section.titleKey, section.titleKey))}</h2>
        <table>${section.rows.map((row) => renderRow(row, t)).join('')}</table>
      </section>`
    )
    .join('');

  const warnings = model.warnings.length
    ? `<section class="warnings">
        <h2>${escapeHtml(t('report.section.warnings', 'Warnings'))}</h2>
        <ul>${model.warnings
          .map(
            (warning) =>
              `<li>${escapeHtml(t(warning.messageKey, warning.messageKey))}${
                warning.detail ? ` <span class="detail">(${escapeHtml(warning.detail)})</span>` : ''
              }</li>`
          )
          .join('')}</ul>
      </section>`
    : '';

  const disclaimers = model.disclaimerKeys
    .map((key) => `<p>${escapeHtml(t(key, key))}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  @page { margin: 16mm 14mm; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #10232b; font-size: 11px; }
  header { border-bottom: 2px solid #0f7f8f; padding-bottom: 8px; margin-bottom: 14px; }
  .wordmark { font-size: 20px; letter-spacing: 5px; font-weight: 700; color: #0b3b45; }
  .subtitle { color: #55707a; margin-top: 2px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1.4px; color: #0f7f8f; margin: 14px 0 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 3px 4px; border-bottom: 1px solid #e2ebee; vertical-align: top; }
  td.label { width: 38%; color: #445c65; }
  td.value { width: 32%; font-weight: 600; }
  td.meta { width: 30%; color: #7d949c; font-size: 10px; }
  tr.withheld td.value { color: #b26a00; font-weight: 700; }
  tr.warning td.value { color: #b00020; }
  .warnings li { color: #8a5300; margin-bottom: 2px; }
  .detail { color: #7d949c; }
  footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #cfdde2; color: #55707a; font-size: 9.5px; }
</style></head>
<body>
  <header>
    <div class="wordmark">FLOWVISION</div>
    <div class="subtitle">${escapeHtml(t('report.title', 'Technical flow measurement report'))}</div>
    <div class="subtitle">${escapeHtml(model.displayId)} · ${escapeHtml(model.createdAt)}${
      model.siteName ? ` · ${escapeHtml(model.siteName)}` : ''
    }</div>
  </header>
  ${sections}
  ${warnings}
  <footer>
    <p>${escapeHtml(t('report.algorithmVersion', 'Algorithm version'))}: ${escapeHtml(
      model.algorithmVersion
    )} · ${escapeHtml(t('report.measurementVersion', 'Record version'))}: ${model.measurementVersion} · ${escapeHtml(
      t('report.processingStatus', 'Processing status')
    )}: ${escapeHtml(model.processingStatus)}</p>
    <p>${escapeHtml(t('report.generatedAt', 'Generated'))}: ${escapeHtml(model.generatedAt)}</p>
    ${disclaimers}
  </footer>
</body></html>`;
}

export type PdfResult =
  | { ok: true; uri: string }
  | { ok: false; error: { code: 'PDF_GENERATION_FAILED'; messageKey: string; detail: string } };

/** Generate the PDF locally. Nothing is uploaded; the file stays on the device. */
export async function generatePdf(model: ReportModel, t: Translate): Promise<PdfResult> {
  try {
    const html = renderReportHtml(model, t);
    const { uri } = await Print.printToFileAsync({ html, base64: false });
    if (!uri) {
      return {
        ok: false,
        error: {
          code: 'PDF_GENERATION_FAILED',
          messageKey: 'report.error.pdfGenerationFailed',
          detail: 'printToFileAsync returned no URI',
        },
      };
    }
    return { ok: true, uri };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'PDF_GENERATION_FAILED',
        messageKey: 'report.error.pdfGenerationFailed',
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
