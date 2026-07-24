import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KpiCard } from '../../src/components/KpiCard';

afterEach(cleanup);

describe('KpiCard comparison', () => {
  it('renders the comparison value and signed percentage delta', () => {
    render(
      <KpiCard
        label="Total Spend"
        value="€1,200"
        sub="July 2026"
        comparison={{
          label: 'vs June 2026',
          value: '€1,000',
          delta: '+€200 · +20%',
          direction: 'up',
          tone: 'neutral',
        }}
      />,
    );

    expect(screen.getByText(/vs June 2026/)).toHaveTextContent('vs June 2026 · €1,000');
    expect(screen.getByText('+€200 · +20%')).toHaveClass('kpi__delta--neutral', 'kpi__delta--up');
  });

  it('renders New for a zero comparison baseline', () => {
    render(
      <KpiCard
        label="Savings"
        value="€100"
        sub="July 2026"
        comparison={{
          label: 'vs June 2026',
          value: '€0',
          delta: '+€100 · New',
          direction: 'up',
          tone: 'favorable',
        }}
      />,
    );

    expect(screen.getByText('+€100 · New')).toHaveClass('kpi__delta--favorable', 'kpi__delta--up');
    expect(document.body.textContent).not.toMatch(/Infinity|NaN/);
  });
});
