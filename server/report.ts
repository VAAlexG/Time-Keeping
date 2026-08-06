import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import type { TimeStore } from './types';
import { getWeekRange, splitEntryByBrisbaneDay } from './time';

const NAVY = '17324D';
const BLUE = '2F6690';
const PALE = 'EAF2F8';
const BORDER = 'C7D5E0';

export interface WeeklyReportResult {
  buffer: Buffer;
  filename: string;
  totalMs: number;
  entryCount: number;
}

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BLUE}` } };
  row.alignment = { vertical: 'middle' };
  row.height = 22;
}

function styleTotal(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: `FF${NAVY}` } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${PALE}` } };
}

export async function buildWeeklyWorkbook(
  store: TimeStore,
  weekStart: string,
  now = new Date(),
): Promise<WeeklyReportResult> {
  const range = getWeekRange(weekStart, now);
  const entries = await store.listEntries({ from: range.from, to: range.to });
  const segments = entries
    .flatMap((entry) => splitEntryByBrisbaneDay(entry, range.from, range.to, now))
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Timekeeper';
  workbook.created = now;
  workbook.modified = now;
  workbook.properties.date1904 = false;
  const sheet = workbook.addWorksheet('Weekly time report', {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  sheet.mergeCells('A1:F1');
  sheet.getCell('A1').value = 'Weekly Time Report';
  sheet.getCell('A1').font = { bold: true, size: 18, color: { argb: `FF${NAVY}` } };
  sheet.getCell('A2').value = 'Week';
  sheet.getCell('B2').value =
    `${DateTime.fromISO(range.weekStart).toFormat('dd LLL yyyy')} – ${DateTime.fromISO(range.weekEnd).toFormat('dd LLL yyyy')}`;
  sheet.getCell('A2').font = { bold: true };
  sheet.addRow([]);
  const header = sheet.addRow([
    'Date',
    'Clock in',
    'Clock out',
    'Duration',
    'Project / activity',
    'Notes',
  ]);
  styleHeader(header);

  const dayTotals = new Map<string, number>();
  const projectTotals = new Map<string, number>();
  let totalMs = 0;
  let currentDate = '';

  for (const segment of segments) {
    if (currentDate && currentDate !== segment.date) {
      const totalRow = sheet.addRow([
        'Daily total',
        '',
        '',
        dayTotals.get(currentDate)! / 86_400_000,
      ]);
      totalRow.getCell(4).numFmt = '[h]"h "mm"m"';
      styleTotal(totalRow);
    }
    currentDate = segment.date;
    const startMinutes = segment.start.hour * 60 + segment.start.minute + segment.start.second / 60;
    const isMidnightEnd =
      segment.end.hour === 0 &&
      segment.end.minute === 0 &&
      segment.end.toISODate() !== segment.date;
    const endMinutes = isMidnightEnd
      ? 24 * 60
      : segment.end.hour * 60 + segment.end.minute + segment.end.second / 60;
    const row = sheet.addRow([
      // Excel stores date serials without a timezone. UTC midnight preserves the Brisbane calendar date.
      DateTime.fromISO(segment.date, { zone: 'utc' }).toJSDate(),
      startMinutes / 1440,
      endMinutes / 1440,
      segment.durationMs / 86_400_000,
      segment.entry.projectName,
      segment.entry.notes,
    ]);
    row.getCell(1).numFmt = 'ddd, dd mmm yyyy';
    row.getCell(2).numFmt = 'h:mm AM/PM';
    row.getCell(3).numFmt = isMidnightEnd ? '[h]:mm' : 'h:mm AM/PM';
    row.getCell(4).numFmt = '[h]"h "mm"m"';
    row.getCell(6).alignment = { wrapText: true, vertical: 'top' };
    dayTotals.set(segment.date, (dayTotals.get(segment.date) ?? 0) + segment.durationMs);
    projectTotals.set(
      segment.entry.projectName,
      (projectTotals.get(segment.entry.projectName) ?? 0) + segment.durationMs,
    );
    totalMs += segment.durationMs;
  }
  if (currentDate) {
    const totalRow = sheet.addRow([
      'Daily total',
      '',
      '',
      dayTotals.get(currentDate)! / 86_400_000,
    ]);
    totalRow.getCell(4).numFmt = '[h]"h "mm"m"';
    styleTotal(totalRow);
  }
  if (!segments.length) {
    const row = sheet.addRow(['No completed or running time was recorded for this week.']);
    sheet.mergeCells(row.number, 1, row.number, 6);
    row.font = { italic: true, color: { argb: 'FF66788A' } };
  }

  sheet.addRow([]);
  const summaryTitle = sheet.addRow(['Project summary']);
  summaryTitle.font = { bold: true, size: 13, color: { argb: `FF${NAVY}` } };
  const summaryHeader = sheet.addRow(['Project / activity', 'Total hours']);
  styleHeader(summaryHeader);
  for (const [project, milliseconds] of [...projectTotals.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const row = sheet.addRow([project, milliseconds / 86_400_000]);
    row.getCell(2).numFmt = '[h]"h "mm"m"';
  }
  const grandTotal = sheet.addRow(['Entire week', totalMs / 86_400_000]);
  grandTotal.getCell(2).numFmt = '[h]"h "mm"m"';
  styleTotal(grandTotal);

  sheet.columns = [
    { width: 20 },
    { width: 13 },
    { width: 13 },
    { width: 14 },
    { width: 28 },
    { width: 52 },
  ];
  sheet.autoFilter = { from: 'A4', to: 'F4' };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber >= 4) {
      row.eachCell((cell) => {
        cell.border = { bottom: { style: 'hair', color: { argb: `FF${BORDER}` } } };
        cell.alignment = { ...cell.alignment, vertical: 'top' };
      });
    }
  });
  sheet.headerFooter.oddFooter = 'Generated by Timekeeper • Brisbane time';
  sheet.pageSetup.printTitlesRow = '1:4';

  const output = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(output),
    filename: `time-report-${range.weekStart}-to-${range.weekEnd}.xlsx`,
    totalMs,
    entryCount: entries.length,
  };
}
