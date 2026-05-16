/**
 * OrderFilter (T065) — dropdown listing every distinct order_code in the
 * snapshot. The "All orders" choice (null) is the default; selecting a
 * specific order narrows the headline view.
 *
 * Per the clarifications session, "Order = Sheet" — every distinct
 * order_code in the snapshot corresponds to one configured sheet.
 */

import type { ChangeEvent } from 'react';

interface Props {
  orders: string[];
  /** null = "All orders". */
  value: string | null;
  onChange: (orderCode: string | null) => void;
}

export function OrderFilter({ orders, value, onChange }: Props): JSX.Element {
  const handleChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    onChange(e.target.value === '' ? null : e.target.value);
  };

  return (
    <label className="filter-field order-filter">
      <span className="filter-field__label order-filter__label">Project</span>
      <span className="select">
        <select
          className="order-filter__select"
          value={value ?? ''}
          onChange={handleChange}
        >
          <option value="">All projects</option>
          {orders.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <span className="select__chev" aria-hidden="true">▾</span>
      </span>
    </label>
  );
}
