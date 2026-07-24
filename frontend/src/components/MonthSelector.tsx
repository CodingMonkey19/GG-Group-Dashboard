/**
 * MonthSelector — month-only filter dropdown (HANDOFF §4.3).
 *
 * Replaces the legacy YYYY-MM/Undated/all selector with a month-name
 * picker that takes values of '01'..'12'. The dashboard year is fixed to
 * 2026, so every option says the year explicitly.
 */

import type { ChangeEvent } from 'react';

const MONTH_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Props {
  visible?: boolean;
  months: string[];
  value: string;
  onChange: (month: string) => void;
  disabled?: boolean;
}

export function MonthSelector({
  visible,
  months,
  value,
  onChange,
  disabled = false,
}: Props): JSX.Element | null {
  if (visible === false) return null;

  const handleChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    onChange(e.target.value);
  };

  return (
    <label className="filter-field month-selector">
      <span className="filter-field__label month-selector__label">Month</span>
      <span className="select">
        <select
          className="month-selector__select"
          value={value}
          onChange={handleChange}
          disabled={disabled}
        >
          {months.map((m) => {
            const idx = Number.parseInt(m, 10);
            const label =
              Number.isFinite(idx) && idx >= 1 && idx <= 12 ? MONTH_SHORT[idx] : m;
            return (
              <option key={m} value={m}>
                {label} 2026
              </option>
            );
          })}
        </select>
        <span className="select__chev" aria-hidden="true">
          ▾
        </span>
      </span>
    </label>
  );
}
