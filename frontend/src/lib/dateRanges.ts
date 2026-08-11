import type { ApiDataResponse } from './contracts';

export interface DateRange {
  from: string;
  to: string;
}

export const REPORTING_MIN_DATE = '2026-01-01';
export const REPORTING_MAX_DATE = '2026-07-31';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseIso(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function isValidDateRange(range: DateRange): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(range.from)
    && /^\d{4}-\d{2}-\d{2}$/.test(range.to)
    && range.from >= REPORTING_MIN_DATE
    && range.to <= REPORTING_MAX_DATE
    && range.from <= range.to;
}

export function rangeForMonth(month: string): DateRange {
  const monthNumber = Number.parseInt(month, 10);
  const lastDay = new Date(Date.UTC(2026, monthNumber, 0)).getUTCDate();
  return {
    from: `2026-${month}-01`,
    to: `2026-${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

export function previousEqualRange(range: DateRange): DateRange {
  const from = parseIso(range.from);
  const to = parseIso(range.to);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const previousTo = new Date(from.getTime() - 86_400_000);
  const previousFrom = new Date(previousTo.getTime() - (days - 1) * 86_400_000);
  const boundedTo = isoDate(previousTo) < REPORTING_MIN_DATE ? REPORTING_MIN_DATE : isoDate(previousTo);
  const boundedFrom = isoDate(previousFrom) < REPORTING_MIN_DATE ? REPORTING_MIN_DATE : isoDate(previousFrom);
  return { from: boundedFrom, to: boundedTo };
}

function datePart(value: string): { day: number; month: number; year: string } {
  const [year = '', month = '1', day = '1'] = value.split('-');
  return { day: Number(day), month: Number(month), year };
}

export function dateRangeLabel(range: DateRange): string {
  const start = datePart(range.from);
  const end = datePart(range.to);
  const startMonth = MONTH_SHORT[start.month - 1] ?? '';
  const endMonth = MONTH_SHORT[end.month - 1] ?? '';
  if (start.year === end.year && start.month === end.month) {
    return `${start.day}–${end.day} ${endMonth} ${end.year}`;
  }
  if (start.year === end.year) {
    return `${start.day} ${startMonth}–${end.day} ${endMonth} ${end.year}`;
  }
  return `${start.day} ${startMonth} ${start.year}–${end.day} ${endMonth} ${end.year}`;
}

export function filterDataByDateRange(data: ApiDataResponse, range: DateRange): ApiDataResponse {
  if (!isValidDateRange(range)) return data;
  return {
    ...data,
    invoices: data.invoices.filter((row) => row.invoice_date >= range.from && row.invoice_date <= range.to),
  };
}
