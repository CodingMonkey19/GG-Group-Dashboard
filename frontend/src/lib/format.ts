/**
 * Display formatting helpers — lifted from prod/public/app.jsx so the
 * spend dashboard's display idioms are identical to the off-page dashboard
 * the CEO already knows (Constitution Principle IV).
 *
 * Date helpers operate exclusively on YYYY-MM / YYYY-MM-DD strings supplied
 * by the backend (FR-024 / FR-018). DO NOT use Date.now() or new Date()
 * here — the constitution forbids client-side derivation of month boundaries.
 *
 * NOTE for tests: T041a includes a grep guard that fails if `Date.now` or
 * `new Date(` appears in this file.
 */

const MONTH_SHORT = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const MONTH_LONG = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2026-04" → "Apr 2026"; "Undated" or null → "Undated". */
export function monthLabel(bucket: string | null | undefined): string {
  if (!bucket || bucket === 'Undated') return 'Undated';
  const [y, m] = bucket.split('-');
  if (y === undefined || m === undefined) return 'Undated';
  const idx = Number.parseInt(m, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > 12) return 'Undated';
  return `${MONTH_SHORT[idx]} ${y}`;
}

/** "2026-04" → "April 2026". */
export function fullMonth(bucket: string | null | undefined): string {
  if (!bucket || bucket === 'Undated') return 'Undated';
  const [y, m] = bucket.split('-');
  if (y === undefined || m === undefined) return 'Undated';
  const idx = Number.parseInt(m, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > 12) return 'Undated';
  return `${MONTH_LONG[idx]} ${y}`;
}

/** "2026-07-06" → "06/07/2026". Keeps every dashboard date in one EU format. */
export function dayLabel(value: string | null | undefined): string {
  if (!value) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

/** Format an EUR amount with the Euro symbol and no decimals. */
export function fmtEur(n: number | null | undefined): string {
  return `€${Math.round(n ?? 0).toLocaleString('en-US')}`;
}

/** Format an EUR amount with two-decimal precision. */
export function fmtEurDec(n: number | null | undefined): string {
  return `€${(n ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a plain integer count. */
export function fmtNum(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

/** Format a fraction (0..1) as a percent. */
export function pct(n: number | null | undefined): string {
  return `${Math.round((n ?? 0) * 100)}%`;
}

/**
 * Compute "{abs date} (N min/h/d ago)" labels for a SERVER-SUPPLIED ISO
 * timestamp.
 *
 * `now` is required from the caller — typically the React component reads it
 * from `useState(() => performance.now()/Date.now())` once at mount. We
 * deliberately do not call Date.now() in this module so the FR-024 grep
 * guard passes; the caller owns the clock.
 */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const min = Math.round((nowMs - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * "2026-04" → "Apr 26". Pure string op; no Date object.
 */
export function monthShortLabel(bucket: string | null | undefined): string {
  if (!bucket || bucket === 'Undated') return 'Undated';
  const [y, m] = bucket.split('-');
  if (y === undefined || m === undefined) return 'Undated';
  const idx = Number.parseInt(m, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > 12) return 'Undated';
  return `${MONTH_SHORT[idx]} ${y.slice(2)}`;
}

/**
 * Compact human label for the redesign's three-axis scope filter.
 *
 *   { year: 'all',  month: 'all'  } → 'all time'
 *   { year: '2026', month: 'all'  } → '2026'
 *   { year: '2026', month: '04'   } → 'April 2026'
 *
 * Pure string op — must not call Date.now / new Date so the FR-024 grep
 * guard in tests/lib/date-source.test.ts stays green.
 */
export function scopeLabelFor(scope: { year: string; month: string }): string {
  if (scope.year === 'all') return 'all time';
  if (scope.month === 'all') return scope.year;
  const idx = Number.parseInt(scope.month, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > 12) return scope.year;
  return `${MONTH_LONG[idx]} ${scope.year}`;
}

/**
 * Shift a YYYY-MM bucket by `offset` months, returning a new YYYY-MM string
 * (or null when the input is undated/invalid).
 */
export function relMonth(bucket: string | null | undefined, offset: number): string | null {
  if (!bucket || bucket === 'Undated') return null;
  const [yStr, mStr] = bucket.split('-');
  if (yStr === undefined || mStr === undefined) return null;
  const y = Number.parseInt(yStr, 10);
  const m = Number.parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;

  // Compute target year/month using integer math — no Date object so the
  // FR-024 grep guard stays clean.
  const totalMonths = (y * 12 + (m - 1)) + offset;
  const targetY = Math.floor(totalMonths / 12);
  const targetM = (totalMonths % 12) + 1;
  return `${targetY}-${String(targetM).padStart(2, '0')}`;
}
