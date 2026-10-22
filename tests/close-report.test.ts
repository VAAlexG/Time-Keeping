import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import {
  csvSafe,
  createResendReportSender,
  renderCloseReportArtifacts,
  type CloseReportSnapshot,
} from '../server/close-report';

const snapshot: CloseReportSnapshot = {
  schemaVersion: 1,
  reportId: 'report-123',
  reportVersion: 2,
  generatedAt: '2026-08-14T10:00:00.000Z',
  confidentiality: 'Confidential practice-only',
  displayTimezone: 'Australia/Brisbane',
  period: {
    id: 'period-1',
    kind: 'scheduled',
    coverageFrom: '2026-08-07T10:00:00.000Z',
    cutoffAt: '2026-08-14T10:00:00.000Z',
    sourceRevision: 1,
    reason: 'Scheduled Friday close',
  },
  entries: [
    {
      id: 'entry-1',
      segmentRootId: 'entry-1',
      segmentParentId: null,
      segmentIndex: 0,
      employeeId: 'user-1',
      employeeName: '=HYPERLINK("https://invalid.example")',
      employeeEmail: 'alex@example.com',
      workType: 'client',
      clientId: 'client-1',
      clientName: 'A client with a long but useful report name',
      clientExternalId: 'contact-1',
      clientCode: 'AC01',
      jobId: 'job-1',
      jobName: 'Year-end accounts',
      jobExternalId: 'job-ext-1',
      jobCode: 'YE',
      internalActivityId: null,
      activityName: null,
      xeroTenantId: 'tenant-1',
      xeroProjectId: 'xero-project-1',
      xeroProjectName: 'Xero year-end project',
      xeroTaskId: 'xero-task-1',
      xeroTaskName: 'Accounts preparation',
      xeroTaskChargeType: 'TIME',
      xeroTaskRateCurrency: 'AUD',
      xeroTaskRateValue: 200,
      xeroSelectionRevision: 3,
      billable: true,
      clientDescription:
        'Prepared the year-end working papers and reviewed the supporting schedules. '.repeat(100),
      internalNote: '+private formula-like note',
      startAt: '2026-08-13T23:00:00.000Z',
      endAt: '2026-08-14T01:30:00.000Z',
      durationMs: 9_000_000,
      revision: 3,
      lockedAt: '2026-08-14T10:00:00.000Z',
      exceptionFlags: [],
    },
  ],
  totals: {
    entryCount: 1,
    totalMs: 9_000_000,
    clientMs: 9_000_000,
    internalMs: 0,
    legacyMs: 0,
    billableMs: 9_000_000,
    nonBillableMs: 0,
    firm: { entryCount: 1, totalMs: 9_000_000, billableMs: 9_000_000, nonBillableMs: 0 },
    byEmployee: [{ key: 'user-1', label: 'Alex', totalMs: 9_000_000 }],
    byClient: [{ key: 'client-1', label: 'A client', totalMs: 9_000_000 }],
    byWorkDay: [{ key: '2026-08-14', label: '2026-08-14', totalMs: 9_000_000 }],
    byInternalOrNonChargeableCategory: [],
  },
};

it('refuses redirects when sending confidential report attachments', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ id: 'email-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  await createResendReportSender('test-key', fetcher).send({
    from: 'reports@example.com',
    to: 'recipient@example.com',
    subject: 'Confidential report',
    text: 'Attached',
    attachments: [{ filename: 'report.pdf', content: new Uint8Array([1, 2, 3]) }],
    idempotencyKey: 'close-report-1',
  });
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
});

describe('immutable close report rendering', () => {
  it('neutralises spreadsheet formulas, including whitespace-prefixed values', () => {
    expect(csvSafe('=1+1')).toBe('"\'=1+1"');
    expect(csvSafe('  @SUM(A1:A2)')).toBe('"\'  @SUM(A1:A2)"');
    expect(csvSafe('ordinary')).toBe('"ordinary"');
  });

  it('renders PDF, UTF-8 BOM CSV and XLSX from one snapshot', async () => {
    const artifacts = await renderCloseReportArtifacts(snapshot);
    expect(artifacts.map((artifact) => artifact.format).sort()).toEqual(['csv', 'pdf', 'xlsx']);
    expect([...artifacts.find((item) => item.format === 'csv')!.content.slice(0, 3)]).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
    const csv = new TextDecoder().decode(artifacts.find((item) => item.format === 'csv')!.content);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+private formula-like note");

    const pdf = await PDFDocument.load(artifacts.find((item) => item.format === 'pdf')!.content);
    expect(pdf.getPageCount()).toBeGreaterThan(1);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      artifacts.find((item) => item.format === 'xlsx')!.content as unknown as ExcelJS.Buffer,
    );
    expect(workbook.getWorksheet('Reviewed time')!.getCell('A1').value).toBe(
      'VERSATILE ACCOUNTING - REVIEWED TIME REPORT',
    );
    expect(workbook.getWorksheet('Summary')!.getCell('B2').value).toBe(9_000_000);
    for (const artifact of artifacts) {
      expect(artifact.content.byteLength).toBeGreaterThan(100);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('preserves extended Latin and Vietnamese names without ASCII replacement', async () => {
    const unicodeSnapshot = structuredClone(snapshot);
    unicodeSnapshot.entries[0].employeeName = 'Zoë Łukasz Đặng';
    unicodeSnapshot.entries[0].clientName = 'Café Żółć – Đối tác';
    unicodeSnapshot.entries[0].clientDescription =
      'Prepared résumé schedules — verified Māori and Tiếng Việt details.';
    const artifacts = await renderCloseReportArtifacts(unicodeSnapshot);
    const csv = new TextDecoder().decode(
      artifacts.find((artifact) => artifact.format === 'csv')!.content,
    );
    expect(csv).toContain('Zoë Łukasz Đặng');
    expect(csv).toContain('Café Żółć – Đối tác');
    expect(csv).not.toContain('Zo?');
    await expect(
      PDFDocument.load(artifacts.find((artifact) => artifact.format === 'pdf')!.content),
    ).resolves.toBeDefined();
  });

  it('renders arbitrary Unicode losslessly across the artifact set without blocking close', async () => {
    const unicodeSnapshot = structuredClone(snapshot);
    unicodeSnapshot.entries[0].employeeName = 'Alex 😀';
    unicodeSnapshot.entries[0].clientName = '客户例子';
    unicodeSnapshot.entries[0].clientDescription = 'تمت مراجعة الملف 👩‍💼';

    const artifacts = await renderCloseReportArtifacts(unicodeSnapshot);
    const csv = new TextDecoder().decode(
      artifacts.find((artifact) => artifact.format === 'csv')!.content,
    );
    expect(csv).toContain('Alex 😀');
    expect(csv).toContain('客户例子');
    expect(csv).toContain('تمت مراجعة الملف 👩‍💼');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      artifacts.find((artifact) => artifact.format === 'xlsx')!
        .content as unknown as ExcelJS.Buffer,
    );
    const detailValues = workbook.getWorksheet('Reviewed time')!.getRow(7).values;
    expect(detailValues).toContain('Alex 😀');
    expect(detailValues).toContain('客户例子');
    expect(detailValues).toContain('تمت مراجعة الملف 👩‍💼');

    await expect(
      PDFDocument.load(artifacts.find((artifact) => artifact.format === 'pdf')!.content),
    ).resolves.toBeDefined();
  });
});
