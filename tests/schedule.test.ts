import { describe, expect, it } from 'vitest';
import { occurrenceDates, type ScheduleTemplateInput } from '../server/schedule';

const base: ScheduleTemplateInput = {
  title: 'Routine',
  description: '',
  assignee: 'suzie',
  recurrenceType: 'weekly',
  weekdays: [1],
  startDate: '2026-08-03',
  monthlyDay: null,
  yearlyMonth: null,
  yearlyDay: null,
  dueTime: null,
};

describe('schedule recurrence', () => {
  it('supports multiple weekly days', () => {
    expect(occurrenceDates({ ...base, weekdays: [1, 4] }, '2026-08-03', '2026-08-16')).toEqual([
      '2026-08-03',
      '2026-08-06',
      '2026-08-10',
      '2026-08-13',
    ]);
  });
  it('anchors fortnightly weeks to the start date', () => {
    expect(
      occurrenceDates({ ...base, recurrenceType: 'fortnightly' }, '2026-08-03', '2026-08-31'),
    ).toEqual(['2026-08-03', '2026-08-17', '2026-08-31']);
  });
  it('clamps monthly dates to the final day', () => {
    expect(
      occurrenceDates(
        {
          ...base,
          recurrenceType: 'monthly',
          weekdays: [],
          startDate: '2026-01-31',
          monthlyDay: 31,
        },
        '2026-01-01',
        '2026-03-31',
      ),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
  it('handles leap-day yearly recurrence', () => {
    expect(
      occurrenceDates(
        {
          ...base,
          recurrenceType: 'yearly',
          weekdays: [],
          startDate: '2027-01-01',
          yearlyMonth: 2,
          yearlyDay: 29,
        },
        '2027-01-01',
        '2028-12-31',
      ),
    ).toEqual(['2027-02-28', '2028-02-29']);
  });
});
