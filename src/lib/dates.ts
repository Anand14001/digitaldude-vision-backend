import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';

dayjs.extend(isoWeek);
dayjs.extend(utc);

export { dayjs };

/** Monday-start week, matching how timesheets are submitted. */
export const weekStart = (d: Date | string = new Date()) =>
  dayjs(d).startOf('isoWeek').toDate();

export const weekEnd = (d: Date | string = new Date()) =>
  dayjs(d).endOf('isoWeek').startOf('day').toDate();

export const startOfDay = (d: Date | string) => dayjs(d).startOf('day').toDate();
export const endOfDay = (d: Date | string) => dayjs(d).endOf('day').toDate();

/** Inclusive day count, with weekends and holidays excluded. */
export function workingDaysBetween(
  start: Date | string,
  end: Date | string,
  opts: { workingDays?: number[]; holidays?: Date[] } = {},
): number {
  const working = opts.workingDays ?? [1, 2, 3, 4, 5, 6]; // Mon-Sat, as the agency works
  const holidaySet = new Set((opts.holidays ?? []).map((h) => dayjs(h).format('YYYY-MM-DD')));
  let cursor = dayjs(start).startOf('day');
  const last = dayjs(end).startOf('day');
  let days = 0;
  while (cursor.isBefore(last) || cursor.isSame(last)) {
    if (working.includes(cursor.day()) && !holidaySet.has(cursor.format('YYYY-MM-DD'))) {
      days += 1;
    }
    cursor = cursor.add(1, 'day');
  }
  return days;
}

/** Period for a retainer cycle starting on a given date. */
export function cyclePeriod(
  start: Date,
  billingCycle: 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'ANNUAL',
): { periodStart: Date; periodEnd: Date; label: string } {
  const months = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, ANNUAL: 12 }[billingCycle];
  const from = dayjs(start).startOf('day');
  const to = from.add(months, 'month').subtract(1, 'day').endOf('day');
  const label =
    billingCycle === 'MONTHLY'
      ? from.format('MMMM YYYY')
      : `${from.format('MMM YYYY')} - ${to.format('MMM YYYY')}`;
  return { periodStart: from.toDate(), periodEnd: to.toDate(), label };
}
