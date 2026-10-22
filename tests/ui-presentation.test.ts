import { describe, expect, it } from 'vitest';
import {
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
