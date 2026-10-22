import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildClientTimePdf } from '../server/client-report';
import type { Client, TimeEntry } from '../server/types';

const client: Client = {
  id: '10000000-0000-4000-8000-000000000001',
  externalId: 'client-1',
  source: 'fyi',
  name: 'Northbridge Joinery & Design',
  clientCode: 'NBJ',
  exportCode: null,
  managerName: null,
  partnerName: null,
  active: true,
  syncedAt: '2026-08-01T00:00:00.000Z',
};

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: crypto.randomUUID(),
    userId: '30000000-0000-4000-8000-000000000001',
    userEmail: 'suzieg@versatileaccounting.com.au',
    userDisplayName: 'Suzie Gardiner',
    projectId: '40000000-0000-4000-8000-000000000001',
    projectName: 'Bookkeeping Fees',
    workType: 'client',
    clientId: client.id,
    clientName: client.name,
    clientExternalId: client.externalId,
    clientCode: client.clientCode,
    jobId: '50000000-0000-4000-8000-000000000001',
    jobName: 'August 2026 bookkeeping',
    jobExternalId: 'job-1',
    jobCode: 'AUG-26',
    internalActivityId: null,
    activityName: null,
    billable: true,
    legacy: false,
    notes: 'Reconciled supplier invoices, applied credits, and prepared payments for approval.',
    clientDescription:
      'Reconciled supplier invoices, applied credits, and prepared payments for approval.',
    internalNote: '',
    startAt: '2026-08-02T13:30:00.000Z',
    endAt: '2026-08-02T15:00:00.000Z',
    revision: 1,
    lockedAt: null,
    closePeriodId: null,
    segmentRootId: 'root-1',
    segmentParentId: null,
    segmentIndex: 0,
    originalStartAt: '2026-08-02T13:30:00.000Z',
    originalEndAt: '2026-08-02T15:00:00.000Z',
    createdAt: '2026-08-02T15:00:00.000Z',
    updatedAt: '2026-08-02T15:00:00.000Z',
    ...overrides,
  };
}

describe('client detailed time PDF', () => {
  it('splits Brisbane days, excludes ineligible entries, and creates a safe filename', async () => {
    const report = await buildClientTimePdf({
      client,
      entries: [
        entry({ startAt: '2026-08-02T13:30:00.000Z', endAt: '2026-08-02T15:00:00.000Z' }),
        entry({ billable: false }),
        entry({ endAt: null }),
      ],
      from: new Date('2026-08-01T14:00:00.000Z'),
      to: new Date('2026-08-31T14:00:00.000Z'),
      fromDate: '2026-08-02',
      toDate: '2026-08-31',
      now: new Date('2026-08-26T02:00:00.000Z'),
    });
    expect(report.rowCount).toBe(2);
    expect(report.totalMs).toBe(90 * 60_000);
    expect(report.filename).toBe(
      'client-time-northbridge-joinery-design-2026-08-02-to-2026-08-31.pdf',
    );
    const document = await PDFDocument.load(report.buffer);
    expect(document.getTitle()).toBe('Detailed time - Northbridge Joinery & Design');
    expect(document.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('paginates long reports and long descriptions without failing', async () => {
    const entries = Array.from({ length: 70 }, (_, index) =>
      entry({
        id: `entry-${index}`,
        startAt: `2026-08-${String((index % 20) + 2).padStart(2, '0')}T00:00:00.000Z`,
        endAt: `2026-08-${String((index % 20) + 2).padStart(2, '0')}T01:00:00.000Z`,
        clientDescription: `Entry ${index + 1}: ${'Detailed reconciliation and supporting-document review. '.repeat(8)}`,
      }),
    );
    const report = await buildClientTimePdf({
      client,
      entries,
      from: new Date('2026-07-31T14:00:00.000Z'),
      to: new Date('2026-08-31T14:00:00.000Z'),
      fromDate: '2026-08-01',
      toDate: '2026-08-31',
      now: new Date('2026-08-31T14:00:00.000Z'),
    });
    const document = await PDFDocument.load(report.buffer);
    expect(report.rowCount).toBe(70);
    expect(report.totalMs).toBe(70 * 60 * 60_000);
    expect(document.getPageCount()).toBeGreaterThan(2);
  });
});
