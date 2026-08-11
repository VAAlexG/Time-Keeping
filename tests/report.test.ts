import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildWeeklyWorkbook } from '../server/report';
import { MemoryTimeStore } from './memory-store';

describe('weekly Excel report', () => {
  it('creates a formatted workbook with split daily and project totals', async () => {
    const store = new MemoryTimeStore();
    const alex = await store.upsertUser({
      accessSubject: 'alex-subject',
      email: 'alexg@versatileaccounting.com.au',
      displayName: 'Alex',
      role: 'admin',
    });
    const brendon = await store.upsertUser({
      accessSubject: 'brendon-subject',
      email: 'brendong@versatileaccounting.com.au',
      displayName: 'Brendon',
      role: 'admin',
    });
    await store.createEntry(alex.id, {
      projectName: 'Coding project',
      notes: 'Release work',
      startAt: new Date('2026-08-04T13:30:00.000Z'),
      endAt: new Date('2026-08-04T14:30:00.000Z'),
    });
    await store.createEntry(brendon.id, {
      projectName: 'Accounting',
      notes: 'Books',
      startAt: new Date('2026-08-05T00:00:00.000Z'),
      endAt: new Date('2026-08-05T02:00:00.000Z'),
    });
    const report = await buildWeeklyWorkbook(
      store,
      '2026-08-03',
      new Date('2026-08-10T00:00:00.000Z'),
    );
    expect(report.filename).toBe('time-report-2026-08-03-to-2026-08-09.xlsx');
    expect(report.totalMs).toBe(3 * 60 * 60_000);
    expect(report.buffer.byteLength).toBeGreaterThan(5000);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(report.buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('Weekly time report')!;
    expect(sheet.getCell('A1').value).toBe('VERSATILE ACCOUNTING - WEEKLY TIME REPORT');
    expect(sheet.getCell('A1').fill).toMatchObject({ fgColor: { argb: '121212' } });
    expect(sheet.getColumn(13).width).toBe(48);
    expect((sheet.getCell('A5').value as Date).toISOString()).toBe('2026-08-04T00:00:00.000Z');
    const values = sheet.getColumn(1).values.map(String);
    expect(values).toContain('Daily total');
    expect(values).toContain('Entire week');
    expect(sheet.getRow(4).values).toContain('External IDs');
    expect(sheet.getColumn(2).values.map(String)).toContain(
      'Alex (alexg@versatileaccounting.com.au)',
    );
    expect(sheet.getColumn(2).values.map(String)).toContain(
      'Brendon (brendong@versatileaccounting.com.au)',
    );
  });
});
