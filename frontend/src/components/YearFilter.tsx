/**
 * YearFilter — top-level year filter (HANDOFF §4.2).
 *
 * Defaults to "All years" so the dashboard opens with the full timeframe.
 * Picking a year unhides the <MonthSelector> next to it.
 */

import type { ChangeEvent } from 'react';

interface Props {
  years: string[];
  value: string;
  onChange: (year: string) => void;
}

export function YearFilter({ years, value, onChange }: Props): JSX.Element {
  const handleChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    onChange(e.target.value);
  };

  return (
    <label className="filter-field year-filter">
      <span className="filter-field__label">Year</span>
      <span className="select">
        <select value={value} onChange={handleChange}>
          <option value="all">All years</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span className="select__chev" aria-hidden="true">
          ▾
        </span>
      </span>
    </label>
  );
}
