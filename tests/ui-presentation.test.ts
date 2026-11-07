import { describe, expect, it } from 'vitest';
import {
  amendmentDefaultStart,
  amendmentIntervalError,
  archivedEmailStatusLabel,
  formatBrisbaneDateTime,
  mergeBillingReviewPage,
  reviewStatusLabel,
} from '../src/App';
import type { BillingReviewData, BillingReviewItem } from '../src/types';

function item(
  entryId: string,
  syncState: BillingReviewItem['syncState'] = 'not_queued',
  reviewState: BillingReviewItem['reviewState'] = 'eligible',
): BillingReviewItem {
  return { entryId, syncState, reviewState } as BillingReviewItem;
}

function page(pageNumber: number, entryIds: string[]): BillingReviewData {
  return {
    page: pageNumber,
    pageSize: 50,
    total: entryIds.length,
    hasMore: false,
    items: entryIds.map((entryId) => item(entryId)),
  } as BillingReviewData;
}

describe('truthful workflow presentation', () => {
  it('shows upload failures before the broader approved review state', () => {
    expect(reviewStatusLabel(item('failed', 'failed', 'approved'))).toBe('Upload failed');
    expect(reviewStatusLabel(item('sending', 'sending', 'approved'))).toBe('Sending to Xero');
    expect(reviewStatusLabel(item('queued', 'queued', 'approved'))).toBe('Queued for Xero');
  });

  it('uses provider-specific archived email labels', () => {
    expect(archivedEmailStatusLabel('pending')).toBe('Queued');
    expect(archivedEmailStatusLabel('sending')).toBe('Sending to provider');
    expect(archivedEmailStatusLabel('sent')).toBe('Provider accepted');
    expect(archivedEmailStatusLabel('failed')).toBe('Failed');
  });

  it('formats close timestamps in Brisbane regardless of the runtime timezone', () => {
    const formatted = formatBrisbaneDateTime('2026-08-14T10:00:00.000Z');
    expect(formatted).toContain('14 Aug 2026');
    expect(formatted).toContain('8:00 pm');
    expect(formatted).toContain('Brisbane');
  });

  it('prefills late-entry drafts at a valid Brisbane weekday morning', () => {
    expect(
      amendmentDefaultStart({
        coverageFrom: '2026-08-07T10:00:00.000Z',
        cutoffAt: '2026-08-14T10:00:00.000Z',
      }),
    ).toBe('2026-08-10T09:00');
  });

  it('rejects late-entry intervals outside coverage or across a Brisbane day', () => {
    const window = {
      coverageFrom: '2026-08-07T10:00:00.000Z',
      cutoffAt: '2026-08-14T10:00:00.000Z',
    };
    expect(
      amendmentIntervalError(window, '2026-08-09T23:00:00.000Z', '2026-08-10T00:00:00.000Z'),
    ).toBeNull();
    expect(
      amendmentIntervalError(window, '2026-08-10T13:00:00.000Z', '2026-08-10T14:00:00.000Z'),
    ).toBeNull();
    expect(
      amendmentIntervalError(window, '2026-08-07T09:30:00.000Z', '2026-08-07T10:30:00.000Z'),
    ).toContain('inside');
    expect(
      amendmentIntervalError(window, '2026-08-10T13:30:00.000Z', '2026-08-10T14:30:00.000Z'),
    ).toContain('calendar day');
  });
});

describe('billing review pagination isolation', () => {
  it('appends only the next page for the accepted query and removes duplicates', () => {
    const merged = mergeBillingReviewPage(page(1, ['one', 'two']), page(2, ['two', 'three']), {
      append: true,
      queryKey: '["failed","alex"]',
      acceptedQueryKey: '["failed","alex"]',
      expectedPage: 2,
    });
    expect(merged?.items.map(({ entryId }) => entryId)).toEqual(['one', 'two', 'three']);
    expect(merged?.page).toBe(2);
  });

  it('ignores append results from a stale query or unexpected page', () => {
    const current = page(1, ['current']);
    expect(
      mergeBillingReviewPage(current, page(2, ['stale']), {
        append: true,
        queryKey: '["failed","old"]',
        acceptedQueryKey: '["failed","new"]',
        expectedPage: 2,
      }),
    ).toBe(current);
    expect(
      mergeBillingReviewPage(current, page(3, ['skipped']), {
        append: true,
        queryKey: '["failed","new"]',
        acceptedQueryKey: '["failed","new"]',
        expectedPage: 2,
      }),
    ).toBe(current);
  });
});
