import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import { getWeekRange, splitEntryByBrisbaneDay } from './time';
import type { PriorityItem, ScheduleOccurrence, TimeEntry, TimeStore } from './types';

const INK = '121212';
const GOLD = 'C08A2A';
const DEEP_GOLD = '8F621A';
const SAND = 'F7F2E9';
const SLATE = '6E706E';
const WHITE = 'FFFFFF';
const BORDER = 'DED7CB';

function employeeLabel(entry: TimeEntry) {
  return `${entry.userDisplayName} (${entry.userEmail})`;
}
function workLabel(entry: TimeEntry) {
  if (entry.workType === 'client') return entry.jobName ?? 'Unassigned project / activity';
  if (entry.workType === 'internal') return entry.activityName ?? entry.projectName;
  return entry.projectName;
}

export async function buildWeeklyWorkbook(
  store: TimeStore,
  weekStart?: string,
  now = new Date(),
  priorities: PriorityItem[] = [],
  schedule: ScheduleOccurrence[] = [],
) {
  const range = getWeekRange(weekStart, now);
  const entries = await store.listEntries({ from: range.from, to: range.to });
  const segments = entries.flatMap((entry) =>
    splitEntryByBrisbaneDay(entry, range.from, range.to, now),
  );
  segments.sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Versatile Accounting Timekeeper';
  workbook.created = now;
  const sheet = workbook.addWorksheet('Weekly time report', {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  sheet.mergeCells('A1:M1');
  sheet.getCell('A1').value = 'VERSATILE ACCOUNTING - WEEKLY TIME REPORT';
  sheet.getCell('A1').font = { bold: true, size: 18, color: { argb: WHITE }, name: 'Archivo' };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
  sheet.getCell('A1').alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 34;
  sheet.mergeCells('A2:M2');
  sheet.getCell('A2').value = `${range.weekStart} to ${range.weekEnd} - Brisbane time`;
  sheet.getCell('A2').font = { italic: true, color: { argb: DEEP_GOLD }, name: 'Archivo' };
  sheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
  sheet.addRow([]);

  const headers = [
    'Date',
    'Employee',
    'Start',
    'End',
    'Duration',
    'Work type',
    'Client',
    'Client code',
    'Job / activity',
    'Job code',
    'Billable',
    'External IDs',
    'Client-facing description',
    'Internal note (practice only)',
  ];
  const header = sheet.addRow(headers);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: INK }, name: 'Archivo' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } };
    cell.alignment = { vertical: 'middle' };
  });
  header.height = 25;

  const dayTotals = new Map<string, number>();
  const clientTotals = new Map<string, number>();
  const jobTotals = new Map<string, number>();
  const employeeTotals = new Map<string, number>();
  let totalMs = 0;
  let billableMs = 0;
  let clientMs = 0;
  let internalMs = 0;
  let currentDate = '';
  const addDailyTotal = (date: string) => {
    const row = sheet.addRow(['Daily total', '', '', '', (dayTotals.get(date) ?? 0) / 86_400_000]);
    row.getCell(5).numFmt = '[h]"h "mm"m"';
    row.font = { bold: true, color: { argb: INK }, name: 'Archivo' };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
  };

  for (const segment of segments) {
    if (currentDate && currentDate !== segment.date) addDailyTotal(currentDate);
    currentDate = segment.date;
    const startMinutes = segment.start.hour * 60 + segment.start.minute + segment.start.second / 60;
    const midnightEnd =
      segment.end.hour === 0 &&
      segment.end.minute === 0 &&
      segment.end.toISODate() !== segment.date;
    const endMinutes = midnightEnd
      ? 1440
      : segment.end.hour * 60 + segment.end.minute + segment.end.second / 60;
    const entry = segment.entry;
    const row = sheet.addRow([
      DateTime.fromISO(segment.date, { zone: 'utc' }).toJSDate(),
      employeeLabel(entry),
      startMinutes / 1440,
      endMinutes / 1440,
      segment.durationMs / 86_400_000,
      entry.workType === 'legacy'
        ? 'Legacy'
        : entry.workType === 'client'
          ? 'Client work'
          : 'Internal work',
      entry.clientName ?? '',
      entry.clientCode ?? '',
      workLabel(entry),
      entry.jobCode ?? '',
      entry.billable ? 'Yes' : 'No',
      [entry.clientExternalId, entry.jobExternalId].filter(Boolean).join(' / '),
      entry.clientDescription,
      entry.internalNote,
    ]);
    row.getCell(1).numFmt = 'ddd, dd mmm yyyy';
    row.getCell(3).numFmt = 'h:mm AM/PM';
    row.getCell(4).numFmt = midnightEnd ? '[h]:mm' : 'h:mm AM/PM';
    row.getCell(5).numFmt = '[h]"h "mm"m"';
    row.getCell(13).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(14).alignment = { wrapText: true, vertical: 'top' };
    row.eachCell((cell) => {
      cell.font = { ...cell.font, name: 'Archivo', color: { argb: INK } };
      cell.border = { bottom: { style: 'hair', color: { argb: BORDER } } };
      cell.alignment = { ...cell.alignment, vertical: 'top' };
    });
    dayTotals.set(segment.date, (dayTotals.get(segment.date) ?? 0) + segment.durationMs);
    const client = entry.clientName ?? (entry.workType === 'internal' ? 'Internal' : 'Legacy');
    const job = workLabel(entry);
    clientTotals.set(client, (clientTotals.get(client) ?? 0) + segment.durationMs);
    jobTotals.set(
      `${client} - ${job}`,
      (jobTotals.get(`${client} - ${job}`) ?? 0) + segment.durationMs,
    );
    const employee = employeeLabel(entry);
    employeeTotals.set(employee, (employeeTotals.get(employee) ?? 0) + segment.durationMs);
    totalMs += segment.durationMs;
    if (entry.billable) billableMs += segment.durationMs;
    if (entry.workType === 'client') clientMs += segment.durationMs;
    if (entry.workType === 'internal') internalMs += segment.durationMs;
  }
  if (currentDate) addDailyTotal(currentDate);
  if (!segments.length) {
    const row = sheet.addRow(['No time was recorded for this week.']);
    sheet.mergeCells(row.number, 1, row.number, 14);
    row.font = { italic: true, color: { argb: SLATE } };
  }

  const addSummary = (title: string, values: Map<string, number>) => {
    sheet.addRow([]);
    const titleRow = sheet.addRow([title]);
    titleRow.font = { bold: true, size: 13, color: { argb: INK }, name: 'Archivo' };
    titleRow.getCell(1).border = { bottom: { style: 'medium', color: { argb: GOLD } } };
    const summaryHeader = sheet.addRow([title.replace(' summary', ''), 'Total hours']);
    summaryHeader.font = { bold: true, color: { argb: WHITE }, name: 'Archivo' };
    summaryHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
    for (const [label, milliseconds] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
      const row = sheet.addRow([label, milliseconds / 86_400_000]);
      row.getCell(2).numFmt = '[h]"h "mm"m"';
    }
  };
  addSummary('Client summary', clientTotals);
  addSummary('Job / activity summary', jobTotals);
  addSummary('Employee summary', employeeTotals);
  sheet.addRow([]);
  const metrics = sheet.addRow([
    'Entire week',
    totalMs / 86_400_000,
    'Billable',
    billableMs / 86_400_000,
    'Client work',
    clientMs / 86_400_000,
    'Internal work',
    internalMs / 86_400_000,
    'Utilisation',
    totalMs ? billableMs / totalMs : 0,
  ]);
  metrics.font = { bold: true, color: { argb: INK }, name: 'Archivo' };
  metrics.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } };
  for (const cell of [2, 4, 6, 8]) metrics.getCell(cell).numFmt = '[h]"h "mm"m"';
  metrics.getCell(10).numFmt = '0.0%';

  sheet.columns = [
    { width: 20 },
    { width: 27 },
    { width: 13 },
    { width: 13 },
    { width: 14 },
    { width: 15 },
    { width: 28 },
    { width: 15 },
    { width: 30 },
    { width: 15 },
    { width: 11 },
    { width: 38 },
    { width: 48 },
    { width: 48 },
  ];
  sheet.autoFilter = { from: 'A4', to: 'M4' };
  sheet.headerFooter.oddFooter = 'Generated by Versatile Accounting Timekeeper - Brisbane time';
  sheet.pageSetup.printTitlesRow = '1:4';

  const prioritySheet = workbook.addWorksheet('Team priorities', {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    views: [{ state: 'frozen', ySplit: 4 }],
  });
  prioritySheet.mergeCells('A1:I1');
  prioritySheet.getCell('A1').value = 'VERSATILE ACCOUNTING - TEAM PRIORITIES';
  prioritySheet.getCell('A1').font = {
    bold: true,
    size: 18,
    color: { argb: WHITE },
    name: 'Archivo',
  };
  prioritySheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
  prioritySheet.getCell('A1').alignment = { vertical: 'middle' };
  prioritySheet.getRow(1).height = 34;
  prioritySheet.mergeCells('A2:I2');
  prioritySheet.getCell('A2').value = `Current priorities as at ${DateTime.fromJSDate(now)
    .setZone('Australia/Brisbane')
    .toFormat('dd LLL yyyy, h:mm a')} Brisbane time`;
  prioritySheet.getCell('A2').font = { italic: true, color: { argb: DEEP_GOLD }, name: 'Archivo' };
  prioritySheet.getCell('A2').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: SAND },
  };
  prioritySheet.addRow([]);
  const priorityHeader = prioritySheet.addRow([
    'Status',
    'Assignee',
    'Priority',
    'Title',
    'Description',
    'Created by',
    'Created',
    'Updated',
    'Completed',
  ]);
  priorityHeader.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: INK }, name: 'Archivo' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } };
    cell.alignment = { vertical: 'middle' };
  });
  priorityHeader.height = 25;
  const assigneeNames = { alex: 'Alex', brendon: 'Brendon', suzie: 'Suzie' } as const;
  for (const priority of priorities) {
    const row = prioritySheet.addRow([
      priority.completed ? 'Completed' : 'Active',
      assigneeNames[priority.assignee],
      priority.priority,
      priority.title,
      priority.description,
      priority.createdByName,
      new Date(priority.createdAt),
      new Date(priority.updatedAt),
      priority.completedAt ? new Date(priority.completedAt) : '',
    ]);
    for (const column of [7, 8, 9]) row.getCell(column).numFmt = 'dd mmm yyyy h:mm AM/PM';
    row.getCell(3).alignment = { horizontal: 'center', vertical: 'top' };
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
    row.eachCell((cell) => {
      cell.font = {
        ...cell.font,
        name: 'Archivo',
        color: { argb: priority.completed ? SLATE : INK },
      };
      cell.border = { bottom: { style: 'hair', color: { argb: BORDER } } };
      cell.alignment = { ...cell.alignment, vertical: 'top' };
      if (priority.completed)
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
    });
  }
  if (!priorities.length) {
    const row = prioritySheet.addRow(['No team priorities are currently recorded.']);
    prioritySheet.mergeCells(row.number, 1, row.number, 9);
    row.font = { italic: true, color: { argb: SLATE }, name: 'Archivo' };
  }
  prioritySheet.columns = [
    { width: 14 },
    { width: 16 },
    { width: 12 },
    { width: 48 },
    { width: 58 },
    { width: 22 },
    { width: 22 },
    { width: 22 },
    { width: 22 },
  ];
  prioritySheet.autoFilter = { from: 'A4', to: 'I4' };
  prioritySheet.headerFooter.oddFooter =
    'Generated by Versatile Accounting Timekeeper - Brisbane time';
  prioritySheet.pageSetup.printTitlesRow = '1:4';

  const scheduleSheet = workbook.addWorksheet('Recurring Schedule', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
    views: [{ state: 'frozen', ySplit: 4 }],
  });
  scheduleSheet.mergeCells('A1:J1');
  scheduleSheet.getCell('A1').value = 'VERSATILE ACCOUNTING - RECURRING SCHEDULE';
  scheduleSheet.getCell('A1').font = {
    bold: true,
    size: 18,
    color: { argb: WHITE },
    name: 'Archivo',
  };
  scheduleSheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
  scheduleSheet.getRow(1).height = 34;
  scheduleSheet.mergeCells('A2:J2');
  scheduleSheet.getCell('A2').value =
    `${range.weekStart} to ${range.weekEnd}, including outstanding overdue work`;
  scheduleSheet.getCell('A2').font = { italic: true, color: { argb: DEEP_GOLD }, name: 'Archivo' };
  scheduleSheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
  scheduleSheet.addRow([]);
  const scheduleHeader = scheduleSheet.addRow([
    'Status',
    'Due date',
    'Due time',
    'Assignee',
    'Title',
    'Description',
    'Recurrence',
    'Completed by',
    'Completed at',
    'Occurrence ID',
  ]);
  scheduleHeader.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: INK }, name: 'Archivo' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } };
  });
  for (const item of schedule) {
    const due = DateTime.fromISO(item.dueAt).setZone('Australia/Brisbane');
    const row = scheduleSheet.addRow([
      item.completed ? 'Completed' : item.overdue ? 'Overdue' : 'Due',
      DateTime.fromISO(item.dueDate, { zone: 'utc' }).toJSDate(),
      item.dueTime ? due.toJSDate() : '',
      assigneeNames[item.assignee],
      item.title,
      item.description,
      item.recurrenceLabel,
      item.completedByName ?? '',
      item.completedAt ? new Date(item.completedAt) : '',
      item.id,
    ]);
    row.getCell(2).numFmt = 'dd mmm yyyy';
    row.getCell(3).numFmt = 'h:mm AM/PM';
    row.getCell(9).numFmt = 'dd mmm yyyy h:mm AM/PM';
    row.eachCell((cell) => {
      cell.font = {
        ...cell.font,
        name: 'Archivo',
        color: { argb: item.overdue ? 'BD3428' : item.completed ? SLATE : INK },
      };
      cell.border = { bottom: { style: 'hair', color: { argb: BORDER } } };
      cell.alignment = { vertical: 'top', wrapText: [5, 6].includes(Number(cell.col)) };
    });
  }
  if (!schedule.length) {
    const row = scheduleSheet.addRow(['No scheduled work is due or overdue for this week.']);
    scheduleSheet.mergeCells(row.number, 1, row.number, 10);
    row.font = { italic: true, color: { argb: SLATE }, name: 'Archivo' };
  }
  scheduleSheet.columns = [
    { width: 14 },
    { width: 16 },
    { width: 14 },
    { width: 16 },
    { width: 35 },
    { width: 50 },
    { width: 20 },
    { width: 22 },
    { width: 24 },
    { width: 38 },
  ];
  scheduleSheet.autoFilter = { from: 'A4', to: 'J4' };
  scheduleSheet.pageSetup.printTitlesRow = '1:4';
  scheduleSheet.headerFooter.oddFooter =
    'Generated by Versatile Accounting Timekeeper - Brisbane time';
  const output = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(output),
    filename: `time-report-${range.weekStart}-to-${range.weekEnd}.xlsx`,
    totalMs,
    entryCount: entries.length,
  };
}
