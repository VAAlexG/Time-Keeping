import ExcelJS from 'exceljs';
import fontkit from '@pdf-lib/fontkit';
import archivoLatinRegular from '@fontsource/archivo/files/archivo-latin-400-normal.woff';
import archivoLatinBold from '@fontsource/archivo/files/archivo-latin-700-normal.woff';
import archivoLatinExtRegular from '@fontsource/archivo/files/archivo-latin-ext-400-normal.woff';
import archivoLatinExtBold from '@fontsource/archivo/files/archivo-latin-ext-700-normal.woff';
import archivoVietnameseRegular from '@fontsource/archivo/files/archivo-vietnamese-400-normal.woff';
import archivoVietnameseBold from '@fontsource/archivo/files/archivo-vietnamese-700-normal.woff';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { BRISBANE_ZONE } from './time';
import { DateTime } from 'luxon';

export const REPORT_ARTIFACT_LIMIT = 1_900_000;
export const CLOSE_REPORT_LONG_ENTRY_MS = 16 * 60 * 60_000;

export type CloseReportExceptionFlag =
  | 'legacy'
  | 'missing_classification'
  | 'missing_xero_selection'
  | 'empty_client_description'
  | 'unusually_long_duration';

export interface CloseGroupedTotal {
  key: string;
  label: string;
  totalMs: number;
}

export interface CloseReportEntry {
  id: string;
  segmentRootId: string;
  segmentParentId: string | null;
  segmentIndex: number;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  workType: 'client' | 'internal' | 'legacy';
  clientId: string | null;
  clientName: string | null;
  clientExternalId: string | null;
  clientCode: string | null;
  jobId: string | null;
  jobName: string | null;
  jobExternalId: string | null;
  jobCode: string | null;
  internalActivityId: string | null;
  activityName: string | null;
  xeroTenantId: string | null;
  xeroProjectId: string | null;
  xeroProjectName: string | null;
  xeroTaskId: string | null;
  xeroTaskName: string | null;
  xeroTaskChargeType: string | null;
  xeroTaskRateCurrency: string | null;
  xeroTaskRateValue: number | null;
  xeroSelectionRevision: number | null;
  billable: boolean;
  clientDescription: string;
  internalNote: string;
  startAt: string;
  endAt: string;
  durationMs: number;
  revision: number;
  lockedAt: string;
  exceptionFlags: CloseReportExceptionFlag[];
}

export interface CloseReportSnapshot {
  schemaVersion: 1;
  reportId: string;
  reportVersion: number;
  generatedAt: string;
  confidentiality: 'Confidential practice-only';
  displayTimezone: 'Australia/Brisbane';
  period: {
    id: string;
    kind: 'initial' | 'scheduled' | 'recovery' | 'manual';
    coverageFrom: string;
    cutoffAt: string;
    sourceRevision: number;
    reason: string;
  };
  entries: CloseReportEntry[];
  totals: {
    entryCount: number;
    totalMs: number;
    clientMs: number;
    internalMs: number;
    legacyMs: number;
    billableMs: number;
    nonBillableMs: number;
    firm: {
      entryCount: number;
      totalMs: number;
      billableMs: number;
      nonBillableMs: number;
    };
    byEmployee: CloseGroupedTotal[];
    byClient: CloseGroupedTotal[];
    byWorkDay: CloseGroupedTotal[];
    byInternalOrNonChargeableCategory: CloseGroupedTotal[];
  };
}

export interface RenderedCloseArtifact {
  format: 'pdf' | 'csv' | 'xlsx';
  filename: string;
  content: Uint8Array;
  sha256: string;
}

interface PeriodRow {
  id: string;
  coverage_from: number;
  cutoff_at: number;
  source_revision: number;
  kind: CloseReportSnapshot['period']['kind'];
  reason: string;
}

interface EntryRow {
  id: string;
  user_id: string;
  user_email: string;
  user_display_name: string;
  work_type: CloseReportEntry['workType'];
  client_id: string | null;
  client_name_snapshot: string | null;
  client_external_id_snapshot: string | null;
  client_code_snapshot: string | null;
  job_id: string | null;
  job_name_snapshot: string | null;
  job_external_id_snapshot: string | null;
  job_code_snapshot: string | null;
  internal_activity_id: string | null;
  activity_name_snapshot: string | null;
  legacy_project_name_snapshot: string | null;
  billable: number;
  client_description: string;
  notes: string;
  start_at: number;
  end_at: number;
  revision: number;
  locked_at: number;
  segment_root_id: string | null;
  segment_parent_id: string | null;
  segment_index: number;
  xero_tenant_id: string | null;
  xero_project_id: string | null;
  xero_project_name: string | null;
  xero_task_id: string | null;
  xero_task_name: string | null;
  xero_task_charge_type: string | null;
  xero_task_rate_currency: string | null;
  xero_task_rate_value: number | null;
  xero_selection_revision: number | null;
}

const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

function exceptionFlags(
  entry: Omit<CloseReportEntry, 'exceptionFlags'>,
): CloseReportExceptionFlag[] {
  const flags: CloseReportExceptionFlag[] = [];
  if (entry.workType === 'legacy') flags.push('legacy');
  if (
    (entry.workType === 'client' && (!entry.clientId || !entry.jobId)) ||
    (entry.workType === 'internal' && !entry.internalActivityId)
  )
    flags.push('missing_classification');
  if (entry.workType === 'client' && (!entry.xeroProjectId || !entry.xeroTaskId))
    flags.push('missing_xero_selection');
  if (entry.workType === 'client' && !entry.clientDescription.trim())
    flags.push('empty_client_description');
  if (entry.durationMs > CLOSE_REPORT_LONG_ENTRY_MS) flags.push('unusually_long_duration');
  return flags;
}

function groupedTotals(
  entries: CloseReportEntry[],
  classify: (entry: CloseReportEntry) => { key: string; label: string } | null,
): CloseGroupedTotal[] {
  const totals = new Map<string, CloseGroupedTotal>();
  for (const entry of entries) {
    const group = classify(entry);
    if (!group) continue;
    const existing = totals.get(group.key);
    if (existing) existing.totalMs += entry.durationMs;
    else totals.set(group.key, { ...group, totalMs: entry.durationMs });
  }
  return [...totals.values()].sort((left, right) => {
    if (left.label !== right.label) return left.label < right.label ? -1 : 1;
    if (left.key === right.key) return 0;
    return left.key < right.key ? -1 : 1;
  });
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function csvSafe(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Spreadsheet programs can treat whitespace-prefixed values as formulas too.
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function durationHours(milliseconds: number): number {
  return Math.round((milliseconds / 3_600_000) * 10000) / 10000;
}

function reportColumns(entry: CloseReportEntry): unknown[] {
  const localStart = DateTime.fromISO(entry.startAt, { zone: 'utc' }).setZone(BRISBANE_ZONE);
  const localEnd = DateTime.fromISO(entry.endAt, { zone: 'utc' }).setZone(BRISBANE_ZONE);
  return [
    entry.id,
    entry.segmentRootId,
    entry.segmentIndex,
    entry.employeeName,
    entry.employeeEmail,
    entry.workType,
    entry.clientName ?? '',
    entry.clientExternalId ?? '',
    entry.clientCode ?? '',
    entry.jobName ?? '',
    entry.jobExternalId ?? '',
    entry.jobCode ?? '',
    entry.activityName ?? '',
    entry.xeroProjectName ?? '',
    entry.xeroProjectId ?? '',
    entry.xeroTaskName ?? '',
    entry.xeroTaskId ?? '',
    entry.xeroTaskChargeType ?? '',
    entry.xeroTaskRateCurrency ?? '',
    entry.xeroTaskRateValue ?? '',
    entry.xeroSelectionRevision ?? '',
    entry.billable ? 'Billable' : 'Non-billable',
    localStart.toFormat('yyyy-MM-dd'),
    localStart.toFormat('yyyy-MM-dd HH:mm:ss'),
    localEnd.toFormat('yyyy-MM-dd HH:mm:ss'),
    entry.durationMs,
    durationHours(entry.durationMs),
    entry.clientDescription,
    entry.internalNote,
    entry.exceptionFlags.join('; '),
    entry.revision,
  ];
}

const HEADERS = [
  'Entry ID',
  'Segment root ID',
  'Segment index',
  'Employee',
  'Employee email',
  'Work type',
  'Client',
  'Client external ID',
  'Client code',
  'Project / job',
  'Job external ID',
  'Job code',
  'Internal activity',
  'Xero project',
  'Xero project ID',
  'Xero task / activity',
  'Xero task ID',
  'Xero charge type',
  'Xero rate currency',
  'Xero rate value',
  'Xero selection revision',
  'Billable status',
  'Work date (Brisbane)',
  'Start (Brisbane)',
  'End (Brisbane)',
  'Exact duration (ms)',
  'Duration (hours)',
  'Client-facing description',
  'Internal note (not uploaded to Xero)',
  'Exception flags',
  'Revision',
] as const;

export async function buildCloseReportSnapshot(input: {
  db: D1Database;
  periodId: string;
  reportId: string;
  reportVersion: number;
  generatedAt?: Date;
}): Promise<CloseReportSnapshot> {
  const period = await input.db
    .prepare(
      `SELECT id, coverage_from, cutoff_at, source_revision, kind, reason
       FROM close_periods WHERE id = ? AND status IN ('closed', 'report_failed')`,
    )
    .bind(input.periodId)
    .first<PeriodRow>();
  if (!period) throw new Error('Closed period not found');

  const rows = await input.db
    .prepare(
      `SELECT e.id, e.user_id, u.email AS user_email, u.display_name AS user_display_name,
        e.work_type, e.client_id, e.client_name_snapshot, e.client_external_id_snapshot,
        e.client_code_snapshot, e.job_id, e.job_name_snapshot, e.job_external_id_snapshot,
        e.job_code_snapshot, e.internal_activity_id, e.activity_name_snapshot,
        e.legacy_project_name_snapshot, e.billable, e.client_description, e.notes,
        e.start_at, e.end_at, e.revision, e.locked_at, e.segment_root_id,
        e.segment_parent_id, e.segment_index,
        xs.tenant_id AS xero_tenant_id, xs.project_id AS xero_project_id,
        xs.project_name_snapshot AS xero_project_name, xs.task_id AS xero_task_id,
        xs.task_name_snapshot AS xero_task_name,
        xs.task_charge_type_snapshot AS xero_task_charge_type,
        xs.task_rate_currency_snapshot AS xero_task_rate_currency,
        xs.task_rate_value_snapshot AS xero_task_rate_value,
        xs.selection_revision AS xero_selection_revision
       FROM time_entries e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN xero_projects_entry_selections xs ON xs.entry_id = e.id
       WHERE e.close_period_id = ? AND e.end_at IS NOT NULL
       ORDER BY e.start_at, e.id`,
    )
    .bind(input.periodId)
    .all<EntryRow>();

  const entries = rows.results.map<CloseReportEntry>((row) => {
    const entry: Omit<CloseReportEntry, 'exceptionFlags'> = {
      id: row.id,
      segmentRootId: row.segment_root_id ?? row.id,
      segmentParentId: row.segment_parent_id,
      segmentIndex: row.segment_index,
      employeeId: row.user_id,
      employeeName: row.user_display_name,
      employeeEmail: row.user_email,
      workType: row.work_type,
      clientId: row.client_id,
      clientName:
        row.work_type === 'legacy' ? row.legacy_project_name_snapshot : row.client_name_snapshot,
      clientExternalId: row.client_external_id_snapshot,
      clientCode: row.client_code_snapshot,
      jobId: row.job_id,
      jobName: row.job_name_snapshot,
      jobExternalId: row.job_external_id_snapshot,
      jobCode: row.job_code_snapshot,
      internalActivityId: row.internal_activity_id,
      activityName: row.activity_name_snapshot,
      xeroTenantId: row.xero_tenant_id,
      xeroProjectId: row.xero_project_id,
      xeroProjectName: row.xero_project_name,
      xeroTaskId: row.xero_task_id,
      xeroTaskName: row.xero_task_name,
      xeroTaskChargeType: row.xero_task_charge_type,
      xeroTaskRateCurrency: row.xero_task_rate_currency,
      xeroTaskRateValue: row.xero_task_rate_value,
      xeroSelectionRevision: row.xero_selection_revision,
      billable: Boolean(row.billable),
      clientDescription: row.client_description,
      internalNote: row.notes,
      startAt: iso(row.start_at),
      endAt: iso(row.end_at),
      durationMs: row.end_at - row.start_at,
      revision: row.revision,
      lockedAt: iso(row.locked_at),
    };
    return { ...entry, exceptionFlags: exceptionFlags(entry) };
  });

  const sum = (predicate: (entry: CloseReportEntry) => boolean) =>
    entries.filter(predicate).reduce((total, entry) => total + entry.durationMs, 0);
  const totalMs = entries.reduce((total, entry) => total + entry.durationMs, 0);
  const billableMs = sum((entry) => entry.billable);
  const nonBillableMs = sum((entry) => !entry.billable);
  return {
    schemaVersion: 1,
    reportId: input.reportId,
    reportVersion: input.reportVersion,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    confidentiality: 'Confidential practice-only',
    displayTimezone: BRISBANE_ZONE,
    period: {
      id: period.id,
      kind: period.kind,
      coverageFrom: iso(period.coverage_from),
      cutoffAt: iso(period.cutoff_at),
      sourceRevision: period.source_revision,
      reason: period.reason,
    },
    entries,
    totals: {
      entryCount: entries.length,
      totalMs,
      clientMs: sum((entry) => entry.workType === 'client'),
      internalMs: sum((entry) => entry.workType === 'internal'),
      legacyMs: sum((entry) => entry.workType === 'legacy'),
      billableMs,
      nonBillableMs,
      firm: { entryCount: entries.length, totalMs, billableMs, nonBillableMs },
      byEmployee: groupedTotals(entries, (entry) => ({
        key: entry.employeeId,
        label: `${entry.employeeName} (${entry.employeeEmail})`,
      })),
      byClient: groupedTotals(entries, (entry) =>
        entry.workType === 'client'
          ? {
              key: entry.clientId ?? 'missing-client',
              label: entry.clientName ?? 'Missing client classification',
            }
          : null,
      ),
      byWorkDay: groupedTotals(entries, (entry) => {
        const date = DateTime.fromISO(entry.startAt, { zone: 'utc' })
          .setZone(BRISBANE_ZONE)
          .toISODate()!;
        return { key: date, label: date };
      }),
      byInternalOrNonChargeableCategory: groupedTotals(entries, (entry) => {
        if (entry.workType === 'internal')
          return {
            key: `internal:${entry.internalActivityId ?? 'missing'}`,
            label: `Internal - ${entry.activityName ?? 'Missing activity'}`,
          };
        if (!entry.billable)
          return {
            key: `non-chargeable:${entry.workType}`,
            label:
              entry.workType === 'client'
                ? 'Non-chargeable client work'
                : 'Legacy / unclassified non-chargeable work',
          };
        return null;
      }),
    },
  };
}

export function renderCloseCsv(snapshot: CloseReportSnapshot): Uint8Array {
  const metadata = [
    ['Versatile Accounting reviewed time report'],
    ['Confidentiality', snapshot.confidentiality],
    ['Display timezone', snapshot.displayTimezone],
    ['Coverage from (UTC)', snapshot.period.coverageFrom],
    ['Cutoff at (UTC)', snapshot.period.cutoffAt],
    [
      'Coverage (Australia/Brisbane)',
      `${DateTime.fromISO(snapshot.period.coverageFrom).setZone(BRISBANE_ZONE).toFormat('yyyy-MM-dd HH:mm:ss')} to ${DateTime.fromISO(snapshot.period.cutoffAt).setZone(BRISBANE_ZONE).toFormat('yyyy-MM-dd HH:mm:ss')}`,
    ],
    ['Report version', snapshot.reportVersion],
    ['Report ID', snapshot.reportId],
    ['Entries', snapshot.totals.entryCount],
    ['Exact total (ms)', snapshot.totals.totalMs],
    [],
  ];
  const rows = [
    ...metadata.map((row) => row.map(csvSafe).join(',')),
    HEADERS.map(csvSafe).join(','),
    ...snapshot.entries.map((entry) => reportColumns(entry).map(csvSafe).join(',')),
  ];
  const summarySections: [string, CloseGroupedTotal[]][] = [
    ['Employee totals', snapshot.totals.byEmployee],
    ['Client totals', snapshot.totals.byClient],
    ['Brisbane work-day totals', snapshot.totals.byWorkDay],
    [
      'Internal / non-chargeable category totals',
      snapshot.totals.byInternalOrNonChargeableCategory,
    ],
  ];
  rows.push(
    '',
    [
      csvSafe('Firm total'),
      csvSafe(snapshot.totals.totalMs),
      csvSafe(durationHours(snapshot.totals.totalMs)),
    ].join(','),
  );
  for (const [heading, groups] of summarySections) {
    rows.push('', csvSafe(heading));
    rows.push(
      [csvSafe('Key'), csvSafe('Label'), csvSafe('Exact duration (ms)'), csvSafe('Hours')].join(
        ',',
      ),
    );
    for (const group of groups)
      rows.push(
        [group.key, group.label, group.totalMs, durationHours(group.totalMs)]
          .map(csvSafe)
          .join(','),
      );
  }
  return new TextEncoder().encode(`\ufeff${rows.join('\r\n')}\r\n`);
}

interface PdfFontSet {
  latin: PDFFont;
  latinExt: PDFFont;
  vietnamese: PDFFont;
}

function pdfText(value: unknown): string {
  const normalized = String(value ?? '')
    .normalize('NFC')
    .replace(/\t/g, '    ');
  return Array.from(normalized, (character) => {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint < 32 && codePoint !== 10 && codePoint !== 13) || codePoint === 127) return ' ';
    if (
      inRanges(codePoint, VIETNAMESE_RANGES) ||
      inRanges(codePoint, LATIN_EXT_RANGES) ||
      inRanges(codePoint, LATIN_RANGES)
    )
      return character;

    // Archivo's bundled web-font subsets intentionally keep the Worker/report
    // small, but do not contain every Unicode script or emoji. Preserve every
    // unsupported code point in a reversible ASCII form rather than failing the
    // entire close or silently substituting a missing glyph. CSV/XLSX artifacts
    // retain the original Unicode text verbatim.
    return `[U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}]`;
  }).join('');
}

function inRanges(codePoint: number, ranges: [number, number][]): boolean {
  return ranges.some(([from, to]) => codePoint >= from && codePoint <= to);
}

const VIETNAMESE_RANGES: [number, number][] = [
  [0x0102, 0x0103],
  [0x0110, 0x0111],
  [0x0128, 0x0129],
  [0x0168, 0x0169],
  [0x01a0, 0x01a1],
  [0x01af, 0x01b0],
  [0x0300, 0x0301],
  [0x0303, 0x0304],
  [0x0308, 0x0309],
  [0x0323, 0x0323],
  [0x0329, 0x0329],
  [0x1ea0, 0x1ef9],
  [0x20ab, 0x20ab],
];
const LATIN_EXT_RANGES: [number, number][] = [
  [0x0100, 0x02ba],
  [0x02bd, 0x02c5],
  [0x02c7, 0x02cc],
  [0x02ce, 0x02d7],
  [0x02dd, 0x02ff],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x1d00, 0x1dbf],
  [0x1e00, 0x1e9f],
  [0x1ef2, 0x1eff],
  [0x2020, 0x2020],
  [0x20a0, 0x20c0],
  [0x2113, 0x2113],
  [0x2c60, 0x2c7f],
  [0xa720, 0xa7ff],
];
const LATIN_RANGES: [number, number][] = [
  [0x0000, 0x00ff],
  [0x0131, 0x0131],
  [0x0152, 0x0153],
  [0x02bb, 0x02bc],
  [0x02c6, 0x02c6],
  [0x02da, 0x02dc],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x2000, 0x206f],
  [0x20ac, 0x20ac],
  [0x2122, 0x2122],
  [0x2191, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];

function fontForCharacter(character: string, fonts: PdfFontSet): PDFFont {
  const codePoint = character.codePointAt(0)!;
  if (inRanges(codePoint, VIETNAMESE_RANGES)) return fonts.vietnamese;
  if (inRanges(codePoint, LATIN_EXT_RANGES)) return fonts.latinExt;
  if (inRanges(codePoint, LATIN_RANGES)) return fonts.latin;
  // All dynamic text is normalised by pdfText() before it reaches this point.
  // Retain a defensive failure for programmer-authored static strings so a
  // future glyph regression is caught in tests instead of corrupting a report.
  throw new Error(`PDF font routing missed U+${codePoint.toString(16).toUpperCase()}`);
}

function snapshotNeedsPdfGlyphFallback(snapshot: CloseReportSnapshot): boolean {
  for (const character of JSON.stringify(snapshot)) {
    const codePoint = character.codePointAt(0)!;
    if (
      !inRanges(codePoint, VIETNAMESE_RANGES) &&
      !inRanges(codePoint, LATIN_EXT_RANGES) &&
      !inRanges(codePoint, LATIN_RANGES)
    )
      return true;
  }
  return false;
}

function fontRuns(text: string, fonts: PdfFontSet): { font: PDFFont; text: string }[] {
  const runs: { font: PDFFont; text: string }[] = [];
  for (const character of text) {
    const font = fontForCharacter(character, fonts);
    const previous = runs.at(-1);
    if (previous?.font === font) previous.text += character;
    else runs.push({ font, text: character });
  }
  return runs;
}

function textWidth(text: string, fonts: PdfFontSet, size: number): number {
  return fontRuns(text, fonts).reduce(
    (width, run) => width + run.font.widthOfTextAtSize(run.text, size),
    0,
  );
}

function drawPdfText(
  page: PDFPage,
  text: string,
  fonts: PdfFontSet,
  options: { x: number; y: number; size: number; color: ReturnType<typeof rgb> },
) {
  let x = options.x;
  for (const run of fontRuns(text, fonts)) {
    page.drawText(run.text, { ...options, x, font: run.font });
    x += run.font.widthOfTextAtSize(run.text, options.size);
  }
}

function wrapText(text: string, fonts: PdfFontSet, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfText(text).split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const originalWord of words) {
      let word = originalWord;
      if (textWidth(word, fonts, size) > maxWidth) {
        if (line) {
          lines.push(line);
          line = '';
        }
        let fragment = '';
        for (const character of word) {
          if (fragment && textWidth(fragment + character, fonts, size) > maxWidth) {
            lines.push(fragment);
            fragment = character;
          } else fragment += character;
        }
        word = fragment;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, fonts, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export async function renderClosePdf(snapshot: CloseReportSnapshot): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const regular: PdfFontSet = {
    latin: await document.embedFont(archivoLatinRegular, { subset: true }),
    latinExt: await document.embedFont(archivoLatinExtRegular, { subset: true }),
    vietnamese: await document.embedFont(archivoVietnameseRegular, { subset: true }),
  };
  const bold: PdfFontSet = {
    latin: await document.embedFont(archivoLatinBold, { subset: true }),
    latinExt: await document.embedFont(archivoLatinExtBold, { subset: true }),
    vietnamese: await document.embedFont(archivoVietnameseBold, { subset: true }),
  };
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 42;
  const contentWidth = pageWidth - margin * 2;
  let page!: PDFPage;
  let y = 0;
  let pageNumber = 0;

  const addPage = () => {
    page = document.addPage([pageWidth, pageHeight]);
    pageNumber += 1;
    y = pageHeight - margin;
    drawPdfText(page, 'VERSATILE ACCOUNTING', bold, {
      x: margin,
      y,
      size: 8,
      color: rgb(0.565, 0.384, 0.102),
    });
    drawPdfText(page, `Reviewed time | page ${pageNumber}`, regular, {
      x: pageWidth - margin - 110,
      y,
      size: 8,
      color: rgb(0.43, 0.44, 0.43),
    });
    y -= 22;
  };
  const ensure = (height: number) => {
    if (y - height < margin) addPage();
  };
  const drawWrapped = (
    text: string,
    options?: { bold?: boolean; size?: number; indent?: number },
  ) => {
    const font = options?.bold ? bold : regular;
    const size = options?.size ?? 9;
    const indent = options?.indent ?? 0;
    const lines = wrapText(text, font, size, contentWidth - indent);
    for (const line of lines) {
      ensure(size + 3);
      drawPdfText(page, line, font, {
        x: margin + indent,
        y,
        size,
        color: rgb(0.07, 0.07, 0.07),
      });
      y -= size + 3;
    }
  };

  addPage();
  drawWrapped('REVIEWED TIME REPORT', { bold: true, size: 18 });
  drawWrapped(snapshot.confidentiality.toUpperCase(), { bold: true, size: 9 });
  if (snapshotNeedsPdfGlyphFallback(snapshot))
    drawWrapped(
      'PDF font note: characters outside the embedded font are shown as [U+CODEPOINT]. CSV and XLSX retain the original Unicode text.',
      { size: 8 },
    );
  y -= 4;
  drawWrapped(
    `${DateTime.fromISO(snapshot.period.coverageFrom).setZone(BRISBANE_ZONE).toFormat('dd LLL yyyy HH:mm')} to ${DateTime.fromISO(snapshot.period.cutoffAt).setZone(BRISBANE_ZONE).toFormat('dd LLL yyyy HH:mm')} Brisbane`,
    { size: 10 },
  );
  drawWrapped(
    `Report ${snapshot.reportId} | version ${snapshot.reportVersion} | ${snapshot.totals.entryCount} entries | ${durationHours(snapshot.totals.totalMs).toFixed(2)} hours`,
    { size: 10 },
  );
  y -= 10;

  const pdfSummarySections: [string, CloseGroupedTotal[]][] = [
    ['BY EMPLOYEE', snapshot.totals.byEmployee],
    ['BY CLIENT', snapshot.totals.byClient],
    ['BY BRISBANE WORK DAY', snapshot.totals.byWorkDay],
    ['BY INTERNAL / NON-CHARGEABLE CATEGORY', snapshot.totals.byInternalOrNonChargeableCategory],
  ];
  for (const [heading, groups] of pdfSummarySections) {
    drawWrapped(heading, { bold: true, size: 9 });
    if (!groups.length) drawWrapped('None', { size: 8, indent: 8 });
    for (const group of groups)
      drawWrapped(`${group.label}: ${durationHours(group.totalMs).toFixed(2)} h`, {
        size: 8,
        indent: 8,
      });
    y -= 4;
  }
  drawWrapped('ENTRY DETAIL', { bold: true, size: 10 });
  y -= 4;

  for (const entry of snapshot.entries) {
    ensure(82);
    page.drawRectangle({
      x: margin,
      y: y - 5,
      width: contentWidth,
      height: 1,
      color: rgb(0.922, 0.851, 0.706),
    });
    y -= 14;
    drawWrapped(
      `${entry.employeeName} | ${entry.workType === 'internal' ? (entry.activityName ?? 'Internal') : (entry.clientName ?? 'Unclassified')}${entry.jobName ? ` / ${entry.jobName}` : ''}`,
      { bold: true, size: 10 },
    );
    const start = DateTime.fromISO(entry.startAt).setZone(BRISBANE_ZONE);
    const end = DateTime.fromISO(entry.endAt).setZone(BRISBANE_ZONE);
    drawWrapped(
      `${start.toFormat('dd LLL yyyy HH:mm')} - ${end.toFormat('HH:mm')} | ${durationHours(entry.durationMs).toFixed(2)} h | ${entry.billable ? 'Billable' : 'Non-billable'}`,
      { size: 8 },
    );
    if (entry.xeroProjectId || entry.xeroTaskId)
      drawWrapped(
        `Xero: ${entry.xeroProjectName ?? '-'} (${entry.xeroProjectId ?? '-'}) / ${entry.xeroTaskName ?? '-'} (${entry.xeroTaskId ?? '-'}) | ${entry.xeroTaskChargeType ?? 'unknown charge type'}`,
        { size: 8, indent: 8 },
      );
    drawWrapped(`Client description: ${entry.clientDescription || '-'}`, { size: 8, indent: 8 });
    drawWrapped(`Internal note: ${entry.internalNote || '-'}`, { size: 8, indent: 8 });
    if (entry.exceptionFlags.length)
      drawWrapped(`Exceptions: ${entry.exceptionFlags.join(', ')}`, { size: 8, indent: 8 });
    y -= 5;
  }

  return document.save({ useObjectStreams: true });
}

export async function renderCloseXlsx(snapshot: CloseReportSnapshot): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Versatile Accounting Timekeeper';
  workbook.created = new Date(snapshot.generatedAt);
  const sheet = workbook.addWorksheet('Reviewed time', {
    views: [{ state: 'frozen', ySplit: 6 }],
    properties: { defaultRowHeight: 18 },
  });
  sheet.mergeCells(1, 1, 1, HEADERS.length);
  const title = sheet.getCell(1, 1);
  title.value = 'VERSATILE ACCOUNTING - REVIEWED TIME REPORT';
  title.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 15, name: 'Arial' };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF121212' } };
  title.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 30;
  sheet.getCell(2, 1).value = 'Coverage (UTC)';
  sheet.getCell(2, 2).value = `${snapshot.period.coverageFrom} to ${snapshot.period.cutoffAt}`;
  sheet.getCell(2, 3).value = snapshot.confidentiality;
  sheet.getCell(2, 4).value = `Display timezone: ${snapshot.displayTimezone}`;
  sheet.getCell(3, 1).value = 'Report version';
  sheet.getCell(3, 2).value = snapshot.reportVersion;
  sheet.getCell(3, 3).value = 'Report ID';
  sheet.getCell(3, 4).value = snapshot.reportId;
  sheet.getCell(4, 1).value = 'Exact total (ms)';
  sheet.getCell(4, 2).value = snapshot.totals.totalMs;
  sheet.getCell(4, 3).value = 'Hours';
  sheet.getCell(4, 4).value = durationHours(snapshot.totals.totalMs);
  const header = sheet.getRow(6);
  header.values = [...HEADERS];
  header.font = { bold: true, color: { argb: 'FF121212' }, name: 'Arial' };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBD9B4' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 34;
  for (const entry of snapshot.entries) {
    const row = sheet.addRow(reportColumns(entry));
    row.alignment = { vertical: 'top', wrapText: true };
    row.font = { name: 'Arial', size: 9 };
  }
  sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: HEADERS.length } };
  sheet.columns.forEach((column, index) => {
    column.width = index === 19 || index === 20 ? 45 : index >= 14 && index <= 16 ? 21 : 16;
  });
  sheet.getColumn(18).numFmt = '0';
  sheet.getColumn(19).numFmt = '0.0000';

  const summary = workbook.addWorksheet('Summary');
  summary.addRow(['Metric', 'Exact milliseconds', 'Hours']);
  const metrics: [string, number][] = [
    ['Total', snapshot.totals.totalMs],
    ['Client', snapshot.totals.clientMs],
    ['Internal', snapshot.totals.internalMs],
    ['Legacy', snapshot.totals.legacyMs],
    ['Billable', snapshot.totals.billableMs],
    ['Non-billable', snapshot.totals.nonBillableMs],
  ];
  for (const [label, milliseconds] of metrics)
    summary.addRow([label, milliseconds, durationHours(milliseconds)]);
  const xlsxSummarySections: [string, CloseGroupedTotal[]][] = [
    ['Employee totals', snapshot.totals.byEmployee],
    ['Client totals', snapshot.totals.byClient],
    ['Brisbane work-day totals', snapshot.totals.byWorkDay],
    [
      'Internal / non-chargeable category totals',
      snapshot.totals.byInternalOrNonChargeableCategory,
    ],
  ];
  for (const [heading, groups] of xlsxSummarySections) {
    summary.addRow([]);
    const headingRow = summary.addRow([heading]);
    headingRow.font = { bold: true, color: { argb: 'FF8F621A' } };
    summary.addRow(['Key', 'Label', 'Exact milliseconds', 'Hours']).font = { bold: true };
    for (const group of groups)
      summary.addRow([group.key, group.label, group.totalMs, durationHours(group.totalMs)]);
  }
  summary.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summary.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF121212' } };
  summary.columns = [{ width: 34 }, { width: 48 }, { width: 22 }, { width: 14 }];
  summary.getColumn(3).numFmt = '0.0000';
  summary.getColumn(4).numFmt = '0.0000';

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

export async function renderCloseReportArtifacts(
  snapshot: CloseReportSnapshot,
): Promise<RenderedCloseArtifact[]> {
  const date = DateTime.fromISO(snapshot.period.cutoffAt, { zone: 'utc' })
    .setZone(BRISBANE_ZONE)
    .toFormat('yyyy-MM-dd');
  const prefix = `reviewed-time-${date}-v${snapshot.reportVersion}`;
  const rendered: Omit<RenderedCloseArtifact, 'sha256'>[] = [
    { format: 'csv', filename: `${prefix}.csv`, content: renderCloseCsv(snapshot) },
    { format: 'pdf', filename: `${prefix}.pdf`, content: await renderClosePdf(snapshot) },
    { format: 'xlsx', filename: `${prefix}.xlsx`, content: await renderCloseXlsx(snapshot) },
  ];
  for (const artifact of rendered) {
    if (!artifact.content.byteLength || artifact.content.byteLength > REPORT_ARTIFACT_LIMIT)
      throw new Error(
        `${artifact.format.toUpperCase()} report is outside the supported attachment size`,
      );
  }
  return Promise.all(
    rendered.map(async (artifact) => ({ ...artifact, sha256: await sha256Hex(artifact.content) })),
  );
}

export interface SavedCloseReport {
  id: string;
  closePeriodId: string;
  version: number;
  snapshot: CloseReportSnapshot;
  snapshotSha256: string;
  artifacts: RenderedCloseArtifact[];
}

function normalizedRecipients(recipients: string[]): string[] {
  return [...new Set(recipients.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

interface SaveCloseReportVersionInput {
  db: D1Database;
  periodId: string;
  recipients: string[];
  suppressDelivery?: boolean;
  correctionReason?: string;
  createdByUserId?: string | null;
  /** Link pending audited corrections in the same atomic batch as this version. */
  correctionIdsToLink?: string[];
  now?: Date;
}

const MAX_REPORT_SAVE_ATTEMPTS = 4;

export async function saveCloseReportVersion(
  input: SaveCloseReportVersionInput,
): Promise<SavedCloseReport> {
  return saveCloseReportVersionAttempt(input, 1);
}

async function saveCloseReportVersionAttempt(
  input: SaveCloseReportVersionInput,
  attempt: number,
): Promise<SavedCloseReport> {
  const now = input.now ?? new Date();
  const correctionIdsToLink = [...new Set(input.correctionIdsToLink ?? [])];
  const latest = await input.db
    .prepare(
      `SELECT id, version FROM report_versions
       WHERE close_period_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .bind(input.periodId)
    .first<{ id: string; version: number }>();
  const version = (latest?.version ?? 0) + 1;
  const reportId = crypto.randomUUID();
  const snapshot = await buildCloseReportSnapshot({
    db: input.db,
    periodId: input.periodId,
    reportId,
    reportVersion: version,
    generatedAt: now,
  });
  const snapshotJson = JSON.stringify(snapshot);
  const snapshotSha256 = await sha256Hex(snapshotJson);
  const artifacts = await renderCloseReportArtifacts(snapshot);
  const manifest = artifacts
    .map((artifact) => `${artifact.format}:${artifact.sha256}:${artifact.content.byteLength}`)
    .sort()
    .join('|');
  const attachmentManifestSha256 = await sha256Hex(manifest);
  const timestamp = now.getTime();
  const statements: D1PreparedStatement[] = [
    input.db
      .prepare(
        `UPDATE close_transaction_guard
         SET asserted = CASE WHEN
           (SELECT COALESCE(MAX(version), 0) FROM report_versions WHERE close_period_id = ?) = ?
           AND (SELECT source_revision FROM close_periods WHERE id = ?) = ?
           THEN 1 ELSE 0 END
         WHERE id = 1`,
      )
      .bind(input.periodId, latest?.version ?? 0, input.periodId, snapshot.period.sourceRevision),
    input.db
      .prepare(
        `INSERT INTO report_versions
         (id, close_period_id, version, supersedes_report_id, snapshot_json,
          snapshot_sha256, entry_count, total_ms, source_revision, correction_reason,
          created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        reportId,
        input.periodId,
        version,
        latest?.id ?? null,
        snapshotJson,
        snapshotSha256,
        snapshot.totals.entryCount,
        snapshot.totals.totalMs,
        snapshot.period.sourceRevision,
        (input.correctionReason ?? '').slice(0, 1000),
        input.createdByUserId ?? null,
        timestamp,
      ),
  ];
  if (correctionIdsToLink.length) {
    const placeholders = correctionIdsToLink.map(() => '?').join(', ');
    statements.push(
      input.db
        .prepare(
          `UPDATE close_transaction_guard
           SET asserted = CASE WHEN (
             SELECT COUNT(*) FROM locked_entry_corrections
             WHERE close_period_id = ? AND revised_report_id IS NULL
               AND id IN (${placeholders})
           ) = ? THEN 1 ELSE 0 END
           WHERE id = 1`,
        )
        .bind(input.periodId, ...correctionIdsToLink, correctionIdsToLink.length),
    );
  }
  for (const artifact of artifacts) {
    statements.push(
      input.db
        .prepare(
          `INSERT INTO report_artifacts
           (report_id, format, filename, content, content_sha256, byte_length, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          reportId,
          artifact.format,
          artifact.filename,
          artifact.content,
          artifact.sha256,
          artifact.content.byteLength,
          timestamp,
        ),
    );
  }
  if (!input.suppressDelivery) {
    for (const recipient of normalizedRecipients(input.recipients)) {
      const recipientHash = (await sha256Hex(recipient)).slice(0, 24);
      statements.push(
        input.db
          .prepare(
            `INSERT INTO report_delivery_outbox
             (id, report_id, recipient, state, next_attempt_at, idempotency_key,
              attachment_manifest_sha256, created_at, updated_at)
             VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            reportId,
            recipient,
            timestamp,
            `timekeeper-close-${reportId}-${recipientHash}`,
            attachmentManifestSha256,
            timestamp,
            timestamp,
          ),
      );
    }
  }
  for (const correctionId of correctionIdsToLink) {
    statements.push(
      input.db
        .prepare(
          `UPDATE locked_entry_corrections SET revised_report_id = ?
           WHERE id = ? AND close_period_id = ? AND revised_report_id IS NULL`,
        )
        .bind(reportId, correctionId, input.periodId),
    );
  }
  try {
    await input.db.batch(statements);
  } catch (error) {
    const concurrent = await input.db
      .prepare(
        `SELECT p.source_revision,
          (SELECT COALESCE(MAX(version), 0) FROM report_versions
           WHERE close_period_id = p.id) AS version
         FROM close_periods p WHERE p.id = ?`,
      )
      .bind(input.periodId)
      .first<{ version: number; source_revision: number }>();
    const reportAdvanced = (concurrent?.version ?? 0) > (latest?.version ?? 0);
    const sourceAdvanced =
      (concurrent?.source_revision ?? snapshot.period.sourceRevision) >
      snapshot.period.sourceRevision;
    if (reportAdvanced || sourceAdvanced) {
      if (attempt < MAX_REPORT_SAVE_ATTEMPTS)
        return saveCloseReportVersionAttempt(input, attempt + 1);
      throw new Error(
        'REPORT_SNAPSHOT_CONFLICT: the close period kept changing while its report was being generated',
      );
    }
    throw error;
  }
  return {
    id: reportId,
    closePeriodId: input.periodId,
    version,
    snapshot,
    snapshotSha256,
    artifacts,
  };
}

interface ArtifactRow {
  format: RenderedCloseArtifact['format'];
  filename: string;
  content: ArrayBuffer;
  content_sha256: string;
  byte_length: number;
}

interface DeliveryRow {
  id: string;
  report_id: string;
  recipient: string;
  attempts: number;
  idempotency_key: string;
  attachment_manifest_sha256: string;
  write_started_at: number | null;
}

export interface ReportMailSender {
  send(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    attachments: { filename: string; content: Uint8Array }[];
    idempotencyKey: string;
  }): Promise<string | undefined>;
}

export class ReportDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'ReportDeliveryError';
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

export function createResendReportSender(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): ReportMailSender {
  if (!apiKey) throw new Error('RESEND_API_KEY is required');
  return {
    async send(input) {
      let response: Response;
      try {
        response = await fetcher('https://api.resend.com/emails', {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': input.idempotencyKey,
          },
          body: JSON.stringify({
            from: input.from,
            to: [input.to],
            subject: input.subject,
            text: input.text,
            attachments: input.attachments.map((attachment) => ({
              filename: attachment.filename,
              content: toBase64(attachment.content),
            })),
          }),
        });
      } catch (error) {
        throw new ReportDeliveryError(
          error instanceof Error ? error.message : 'The email request did not complete',
          true,
          true,
        );
      }
      const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!response.ok) {
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new ReportDeliveryError(
          `Resend delivery failed (${response.status}): ${body.message ?? 'Unknown error'}`,
          retryable,
        );
      }
      if (!body.id)
        throw new ReportDeliveryError('Resend accepted the request without an id', true, true);
      return body.id;
    },
  };
}

function retryDelay(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export async function processReportDeliveryOutbox(input: {
  db: D1Database;
  mailer: ReportMailSender;
  from: string;
  now?: Date;
  limit?: number;
}): Promise<{ accepted: number; retried: number; needsAttention: number }> {
  const now = input.now ?? new Date();
  const timestamp = now.getTime();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
  const uncertainCutoff = timestamp - 24 * 60 * 60_000;
  const leaseRecovery = await input.db.batch([
    input.db
      .prepare(
        `UPDATE report_delivery_outbox
         SET state = 'needs_attention', lease_token = NULL, lease_until = 0,
             last_error = 'Delivery outcome is uncertain and the provider idempotency window has expired',
             updated_at = ?
         WHERE state = 'leased' AND lease_until <= ?
           AND write_started_at IS NOT NULL AND write_started_at <= ?`,
      )
      .bind(timestamp, timestamp, uncertainCutoff),
    input.db
      .prepare(
        `UPDATE report_delivery_outbox
         SET state = 'queued', lease_token = NULL, lease_until = 0, next_attempt_at = ?, updated_at = ?
         WHERE state = 'leased' AND lease_until <= ?
           AND (write_started_at IS NULL OR write_started_at > ?)`,
      )
      .bind(timestamp, timestamp, timestamp, uncertainCutoff),
    input.db
      .prepare(
        `UPDATE report_delivery_outbox
         SET state = 'needs_attention', lease_token = NULL, lease_until = 0,
             last_error = 'Delivery outcome remained uncertain beyond the provider idempotency window',
             updated_at = ?
         WHERE state = 'failed' AND write_started_at IS NOT NULL
           AND write_started_at <= ? AND last_error LIKE 'AMBIGUOUS:%'`,
      )
      .bind(timestamp, uncertainCutoff),
  ]);

  let accepted = 0;
  let retried = 0;
  let needsAttention =
    Number(leaseRecovery[0].meta.changes ?? 0) + Number(leaseRecovery[2].meta.changes ?? 0);
  for (let index = 0; index < limit; index += 1) {
    const ready = await input.db
      .prepare(
        `SELECT id FROM report_delivery_outbox
         WHERE state IN ('queued', 'failed') AND next_attempt_at <= ?
         ORDER BY next_attempt_at, created_at LIMIT 1`,
      )
      .bind(timestamp)
      .first<{ id: string }>();
    if (!ready) break;
    const lease = crypto.randomUUID();
    const claim = await input.db
      .prepare(
        `UPDATE report_delivery_outbox
         SET state = 'leased', attempts = attempts + 1, lease_token = ?, lease_until = ?,
             updated_at = ?
         WHERE id = ? AND state IN ('queued', 'failed') AND next_attempt_at <= ?`,
      )
      .bind(lease, timestamp + 5 * 60_000, timestamp, ready.id, timestamp)
      .run();
    if (!claim.meta.changes) continue;
    const delivery = await input.db
      .prepare(
        `SELECT id, report_id, recipient, attempts, idempotency_key,
          attachment_manifest_sha256, write_started_at
         FROM report_delivery_outbox WHERE id = ? AND lease_token = ?`,
      )
      .bind(ready.id, lease)
      .first<DeliveryRow>();
    if (!delivery) continue;

    const result = await input.db
      .prepare(
        `SELECT format, filename, content, content_sha256, byte_length
         FROM report_artifacts WHERE report_id = ? ORDER BY format`,
      )
      .bind(delivery.report_id)
      .all<ArtifactRow>();
    const artifacts = result.results;
    const verifiedArtifacts = await Promise.all(
      artifacts.map(async (artifact) => {
        const content = new Uint8Array(artifact.content);
        return { artifact, content, actualSha256: await sha256Hex(content) };
      }),
    );
    const manifest = verifiedArtifacts
      .map(
        ({ artifact, content, actualSha256 }) =>
          `${artifact.format}:${actualSha256}:${content.byteLength}`,
      )
      .join('|');
    if (
      artifacts.length !== 3 ||
      verifiedArtifacts.some(
        ({ artifact, content, actualSha256 }) =>
          artifact.byte_length !== content.byteLength || artifact.content_sha256 !== actualSha256,
      ) ||
      (await sha256Hex(manifest)) !== delivery.attachment_manifest_sha256
    ) {
      await input.db
        .prepare(
          `UPDATE report_delivery_outbox
           SET state = 'needs_attention', lease_token = NULL, lease_until = 0,
               last_error = 'Stored report attachment manifest did not match', updated_at = ?
           WHERE id = ? AND lease_token = ?`,
        )
        .bind(timestamp, delivery.id, lease)
        .run();
      needsAttention += 1;
      continue;
    }

    await input.db
      .prepare(
        `UPDATE report_delivery_outbox
         SET write_started_at = COALESCE(write_started_at, ?), updated_at = ?
         WHERE id = ? AND lease_token = ?`,
      )
      .bind(timestamp, timestamp, delivery.id, lease)
      .run();
    try {
      const providerId = await input.mailer.send({
        from: input.from,
        to: delivery.recipient,
        subject: 'Versatile Accounting reviewed time report',
        text: 'Attached are the immutable PDF, CSV and Excel exports for this reviewed-time report version.',
        attachments: verifiedArtifacts.map(({ artifact, content }) => ({
          filename: artifact.filename,
          content,
        })),
        idempotencyKey: delivery.idempotency_key,
      });
      await input.db
        .prepare(
          `UPDATE report_delivery_outbox
           SET state = 'provider_accepted', provider_message_id = ?, accepted_at = ?,
               lease_token = NULL, lease_until = 0, last_error = NULL, updated_at = ?
           WHERE id = ? AND lease_token = ?`,
        )
        .bind(providerId ?? null, timestamp, timestamp, delivery.id, lease)
        .run();
      accepted += 1;
    } catch (error) {
      const deliveryError =
        error instanceof ReportDeliveryError
          ? error
          : new ReportDeliveryError(
              error instanceof Error ? error.message : 'Unknown report delivery error',
              true,
              true,
            );
      const uncertainExpired =
        deliveryError.ambiguous && (delivery.write_started_at ?? timestamp) <= uncertainCutoff;
      const attention = !deliveryError.retryable || uncertainExpired || delivery.attempts >= 6;
      await input.db
        .prepare(
          `UPDATE report_delivery_outbox
           SET state = ?, next_attempt_at = ?, lease_token = NULL, lease_until = 0,
               last_error = ?, updated_at = ?
           WHERE id = ? AND lease_token = ?`,
        )
        .bind(
          attention ? 'needs_attention' : 'failed',
          attention ? timestamp : timestamp + retryDelay(delivery.attempts),
          `${deliveryError.ambiguous ? 'AMBIGUOUS: ' : ''}${deliveryError.message}`.slice(0, 1000),
          timestamp,
          delivery.id,
          lease,
        )
        .run();
      if (attention) needsAttention += 1;
      else retried += 1;
    }
  }
  return { accepted, retried, needsAttention };
}
