import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WebsiteTable } from '../../src/components/WebsiteTable';
import type { WebsiteCurrentPrice } from '../../src/lib/selectors';

afterEach(cleanup);

function website(
  name: string,
  price: number,
  date: string,
  history: number,
): WebsiteCurrentPrice {
  return {
    website: name,
    current_price_eur: price,
    current_price_native_amount: price,
    current_price_native_currency: 'EUR',
    current_price_invoice_date: date,
    current_price_source_row_key: name,
    current_price_payment_status: 'paid',
    current_price_live_url: `https://${name}/article`,
    history_count: history,
    undated_count: 0,
  };
}

const ROWS = [
  website('alpha.example', 50, '2026-01-10', 1),
  website('beta.example', 100, '2026-04-15', 3),
  website('gamma.example', 150, '2026-06-20', 6),
];

function expectOnly(name: string): void {
  for (const candidate of ['alpha.example', 'beta.example', 'gamma.example']) {
    const link = screen.queryByRole('link', { name: `${candidate}/article` });
    if (candidate === name) expect(link).toBeInTheDocument();
    else expect(link).not.toBeInTheDocument();
  }
}

describe('WebsiteTable filters', () => {
  it('filters every visible column and clears all filters', () => {
    render(<WebsiteTable rows={ROWS} />);

    fireEvent.change(screen.getByLabelText('Filter Live URL'), { target: { value: 'BETA' } });
    expectOnly('beta.example');
    expect(screen.getByText('1 of 3 shown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    fireEvent.change(screen.getByLabelText('Minimum current price'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Maximum current price'), { target: { value: '110' } });
    expectOnly('beta.example');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    fireEvent.change(screen.getByLabelText('As of date from'), { target: { value: '2026-04-01' } });
    fireEvent.change(screen.getByLabelText('As of date to'), { target: { value: '2026-05-31' } });
    expectOnly('beta.example');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    fireEvent.change(screen.getByLabelText('Minimum history count'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Maximum history count'), { target: { value: '6' } });
    expectOnly('gamma.example');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByText(/shown$/)).not.toBeInTheDocument();
  });

  it('combines filters and preserves a clear filtered-empty state', () => {
    render(<WebsiteTable rows={ROWS} />);

    fireEvent.change(screen.getByLabelText('Filter Live URL'), { target: { value: 'alpha' } });
    fireEvent.change(screen.getByLabelText('Minimum current price'), { target: { value: '100' } });

    expect(screen.getByText('No live URLs match these filters')).toBeInTheDocument();
    expect(screen.getByText('0 of 3 shown')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });
});
