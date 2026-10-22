import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { DateTime } from 'luxon';
import { formatDuration, splitEntryByBrisbaneDay } from './time';
import type { Client, TimeEntry } from './types';

const PAGE_SIZE: [number, number] = [841.89, 595.28];
const MARGIN = 40;
const TABLE_BOTTOM = 40;
const INK = rgb(0.071, 0.071, 0.071);
const GOLD = rgb(0.753, 0.541, 0.165);
const SAND = rgb(0.969, 0.949, 0.914);
const SLATE = rgb(0.431, 0.439, 0.431);
const WHITE = rgb(1, 1, 1);
const LINE = rgb(0.871, 0.843, 0.796);

export interface ClientReportInput {
  client: Client;
  entries: TimeEntry[];
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
  now?: Date;
  logo?: Uint8Array;
}

function safeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\x20-\x7e]/g, '?');
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const paragraphs = safeText(text).split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const originalWord of words) {
      const parts: string[] = [];
      let word = originalWord;
      while (font.widthOfTextAtSize(word, size) > width) {
        let cut = word.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(`${word.slice(0, cut)}-`, size) > width) cut--;
        parts.push(`${word.slice(0, cut)}-`);
        word = word.slice(cut);
      }
      parts.push(word);
      for (const part of parts) {
        const candidate = current ? `${current} ${part}` : part;
        if (font.widthOfTextAtSize(candidate, size) <= width) current = candidate;
        else {
          if (current) lines.push(current);
          current = part;
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

function filenamePart(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'client'
  );
}

export async function buildClientTimePdf(input: ClientReportInput) {
  const completed = input.entries.filter(
    (entry) => entry.endAt && entry.workType === 'client' && entry.billable,
  );
  const segments = completed
    .flatMap((entry) => splitEntryByBrisbaneDay(entry, input.from, input.to, input.now))
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
  if (!segments.length) throw new Error('NO_CLIENT_REPORT_ENTRIES');

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Detailed time - ${input.client.name}`);
  pdf.setAuthor('Versatile Accounting');
  pdf.setCreator('Versatile Accounting Timekeeper');
  pdf.setCreationDate(input.now ?? new Date());
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let logo: Awaited<ReturnType<typeof pdf.embedPng>> | undefined;
  if (input.logo) {
    try {
      logo = await pdf.embedPng(input.logo);
    } catch {
      logo = undefined;
    }
  }

  const employeeTotals = new Map<string, number>();
  let totalMs = 0;
  for (const segment of segments) {
    totalMs += segment.durationMs;
    employeeTotals.set(
      segment.entry.userDisplayName,
      (employeeTotals.get(segment.entry.userDisplayName) ?? 0) + segment.durationMs,
    );
  }

  const pages: PDFPage[] = [];
  const addPage = (continuation = false) => {
    const page = pdf.addPage(PAGE_SIZE);
    pages.push(page);
    page.drawRectangle({
      x: 0,
      y: PAGE_SIZE[1] - 12,
      width: PAGE_SIZE[0],
      height: 12,
      color: GOLD,
    });
    if (continuation) {
      page.drawText('DETAILED TIME - CONTINUED', {
        x: MARGIN,
        y: PAGE_SIZE[1] - 40,
        size: 13,
        font: bold,
        color: INK,
      });
      page.drawText(safeText(input.client.name), {
        x: MARGIN,
        y: PAGE_SIZE[1] - 58,
        size: 9,
        font: regular,
        color: SLATE,
      });
    }
    return page;
  };

  let page = addPage();
  let y = PAGE_SIZE[1] - 45;
  if (logo) {
    const scaled = logo.scaleToFit(170, 42);
    page.drawImage(logo, {
      x: MARGIN,
      y: y - scaled.height + 6,
      width: scaled.width,
      height: scaled.height,
    });
  } else {
    page.drawText('VERSATILE ACCOUNTING', { x: MARGIN, y, size: 16, font: bold, color: INK });
  }
  page.drawText('CLIENT DETAILED TIME REPORT', {
    x: 485,
    y,
    size: 17,
    font: bold,
    color: INK,
  });
  page.drawText('Transparent detail of completed billable work', {
    x: 485,
    y: y - 18,
    size: 9,
    font: regular,
    color: SLATE,
  });

  y -= 72;
  page.drawRectangle({
    x: MARGIN,
    y: y - 92,
    width: PAGE_SIZE[0] - MARGIN * 2,
    height: 104,
    color: SAND,
  });
  page.drawText('PREPARED FOR', { x: MARGIN + 18, y: y - 8, size: 7, font: bold, color: SLATE });
  page.drawText(safeText(input.client.name), {
    x: MARGIN + 18,
    y: y - 29,
    size: 16,
    font: bold,
    color: INK,
  });
  page.drawText('REPORTING PERIOD', {
    x: MARGIN + 365,
    y: y - 8,
    size: 7,
    font: bold,
    color: SLATE,
  });
  const period = `${DateTime.fromISO(input.fromDate).toFormat('d LLL yyyy')} to ${DateTime.fromISO(input.toDate).toFormat('d LLL yyyy')}`;
  page.drawText(period, { x: MARGIN + 365, y: y - 29, size: 11, font: bold, color: INK });
  page.drawText('TOTAL TIME', { x: MARGIN + 18, y: y - 61, size: 7, font: bold, color: SLATE });
  page.drawText(formatDuration(totalMs), {
    x: MARGIN + 18,
    y: y - 81,
    size: 14,
    font: bold,
    color: INK,
  });
  page.drawText('DETAILED ROWS', { x: MARGIN + 175, y: y - 61, size: 7, font: bold, color: SLATE });
  page.drawText(String(segments.length), {
    x: MARGIN + 175,
    y: y - 81,
    size: 14,
    font: bold,
    color: INK,
  });
  page.drawText('GENERATED', { x: MARGIN + 365, y: y - 61, size: 7, font: bold, color: SLATE });
  page.drawText(
    DateTime.fromJSDate(input.now ?? new Date())
      .setZone('Australia/Brisbane')
      .toFormat('d LLL yyyy, h:mm a'),
    { x: MARGIN + 365, y: y - 81, size: 10, font: regular, color: INK },
  );
  y -= 118;

  page.drawText('STAFF TOTALS', { x: MARGIN, y, size: 8, font: bold, color: SLATE });
  y -= 17;
  for (const [employee, duration] of [...employeeTotals].sort(([a], [b]) => a.localeCompare(b))) {
    page.drawText(safeText(employee), { x: MARGIN, y, size: 9, font: regular, color: INK });
    page.drawText(formatDuration(duration), { x: 265, y, size: 9, font: bold, color: INK });
    y -= 15;
  }
  y -= 13;

  const columns = [
    { label: 'DATE', x: MARGIN, width: 72 },
    { label: 'STAFF', x: MARGIN + 72, width: 105 },
    { label: 'JOB / ACTIVITY', x: MARGIN + 177, width: 140 },
    { label: 'WORK PERFORMED', x: MARGIN + 317, width: 365 },
    { label: 'TIME', x: MARGIN + 682, width: 80 },
  ];
  const drawTableHeader = () => {
    page.drawRectangle({
      x: MARGIN,
      y: y - 20,
      width: PAGE_SIZE[0] - MARGIN * 2,
      height: 22,
      color: INK,
    });
    for (const column of columns)
      page.drawText(column.label, {
        x: column.x + 6,
        y: y - 13,
        size: 7,
        font: bold,
        color: WHITE,
      });
    y -= 25;
  };
  const newDetailPage = () => {
    page = addPage(true);
    y = PAGE_SIZE[1] - 80;
    drawTableHeader();
  };
  drawTableHeader();

  for (const segment of segments) {
    const entry = segment.entry;
    const dateLines = wrapText(
      DateTime.fromISO(segment.date).toFormat('d LLL yyyy'),
      regular,
      8,
      60,
    );
    const staffLines = wrapText(entry.userDisplayName, regular, 8, 93);
    const jobLines = wrapText(entry.jobName ?? 'Unassigned project / activity', regular, 8, 128);
    // Client reports must never expose the practice-only internal note.
    const noteLines = wrapText(
      entry.clientDescription || 'No client-facing description provided',
      regular,
      8,
      353,
    );
    const lineCount = Math.max(
      dateLines.length,
      staffLines.length,
      jobLines.length,
      noteLines.length,
    );
    let offset = 0;
    while (offset < lineCount) {
      const availableLines = Math.max(1, Math.floor((y - TABLE_BOTTOM - 8) / 10));
      if (availableLines < 2) {
        newDetailPage();
        continue;
      }
      const chunk = Math.min(lineCount - offset, availableLines);
      const rowHeight = chunk * 10 + 9;
      const continuing = offset > 0;
      const drawLines = (lines: string[], x: number, width: number) => {
        for (let index = 0; index < chunk; index++) {
          const value = lines[offset + index];
          if (value !== undefined)
            page.drawText(value, {
              x: x + 6,
              y: y - 10 - index * 10,
              size: 8,
              font: regular,
              color: INK,
              maxWidth: width - 12,
            });
        }
      };
      if (!continuing) {
        drawLines(dateLines, columns[0].x, columns[0].width);
        drawLines(staffLines, columns[1].x, columns[1].width);
        drawLines(jobLines, columns[2].x, columns[2].width);
        page.drawText(formatDuration(segment.durationMs), {
          x: columns[4].x + 6,
          y: y - 10,
          size: 8,
          font: bold,
          color: INK,
        });
      } else {
        page.drawText('continued', {
          x: columns[2].x + 6,
          y: y - 10,
          size: 7,
          font: regular,
          color: SLATE,
        });
      }
      drawLines(noteLines, columns[3].x, columns[3].width);
      page.drawLine({
        start: { x: MARGIN, y: y - rowHeight },
        end: { x: PAGE_SIZE[0] - MARGIN, y: y - rowHeight },
        thickness: 0.5,
        color: LINE,
      });
      y -= rowHeight;
      offset += chunk;
      if (offset < lineCount) newDetailPage();
    }
  }

  if (y < TABLE_BOTTOM + 45) newDetailPage();
  y -= 14;
  page.drawRectangle({
    x: PAGE_SIZE[0] - MARGIN - 225,
    y: y - 27,
    width: 225,
    height: 36,
    color: GOLD,
  });
  page.drawText('TOTAL BILLABLE TIME', {
    x: PAGE_SIZE[0] - MARGIN - 213,
    y: y - 11,
    size: 8,
    font: bold,
    color: INK,
  });
  page.drawText(formatDuration(totalMs), {
    x: PAGE_SIZE[0] - MARGIN - 72,
    y: y - 13,
    size: 12,
    font: bold,
    color: INK,
  });

  for (const [index, currentPage] of pages.entries()) {
    currentPage.drawText('Versatile Accounting | Client detailed time | Brisbane time', {
      x: MARGIN,
      y: 18,
      size: 7,
      font: regular,
      color: SLATE,
    });
    const label = `Page ${index + 1} of ${pages.length}`;
    currentPage.drawText(label, {
      x: PAGE_SIZE[0] - MARGIN - regular.widthOfTextAtSize(label, 7),
      y: 18,
      size: 7,
      font: regular,
      color: SLATE,
    });
  }

  return {
    buffer: await pdf.save(),
    filename: `client-time-${filenamePart(input.client.name)}-${input.fromDate}-to-${input.toDate}.pdf`,
    totalMs,
    rowCount: segments.length,
  };
}
