import type { ChangeEvent } from 'react';
import { scopeLabelFor } from '../lib/format';

export type ComparisonSelection = 'off' | 'previous' | 'custom' | `month:${string}`;

interface Props {
  months: string[];
  currentMonth: string;
  value: ComparisonSelection;
  onChange: (selection: ComparisonSelection) => void;
  disabled?: boolean;
  rangeMode?: boolean;
}

export function resolveComparisonMonth(
  selection: ComparisonSelection,
  currentMonth: string,
  availableMonths: string[],
): string | null {
  if (selection === 'off') return null;
  if (selection === 'custom') return null;
  if (selection === 'previous') {
    const currentIndex = availableMonths.indexOf(currentMonth);
    return currentIndex > 0 ? (availableMonths[currentIndex - 1] ?? null) : null;
  }
  const candidate = selection.slice('month:'.length);
  return candidate !== currentMonth && availableMonths.includes(candidate) ? candidate : null;
}

export function CompareSelector({
  months,
  currentMonth,
  value,
  onChange,
  disabled = false,
  rangeMode = false,
}: Props): JSX.Element {
  const hasPrevious = months.indexOf(currentMonth) > 0;
  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    onChange(event.target.value as ComparisonSelection);
  };

  return (
    <label className="filter-field compare-selector">
      <span className="filter-field__label compare-selector__label">Compare</span>
      <span className="select">
        <select
          className="compare-selector__select"
          value={value}
          onChange={handleChange}
          disabled={disabled}
        >
          <option value="off">Off</option>
          {rangeMode ? (
            <option value="custom">Custom period</option>
          ) : (
            <>
              <option value="previous" disabled={!hasPrevious}>Previous month</option>
              {months.filter((month) => month !== currentMonth).map((month) => (
                <option key={month} value={`month:${month}`}>
                  {scopeLabelFor({ year: '2026', month })}
                </option>
              ))}
            </>
          )}
        </select>
        <span className="select__chev" aria-hidden="true">▾</span>
      </span>
    </label>
  );
}
