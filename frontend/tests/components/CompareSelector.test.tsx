import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompareSelector,
  resolveComparisonMonth,
  type ComparisonSelection,
} from '../../src/components/CompareSelector';

afterEach(cleanup);

describe('CompareSelector', () => {
  it('resolves only valid 2026 comparison months', () => {
    expect(resolveComparisonMonth('previous', '04', ['01', '03', '04'])).toBe('03');
    expect(resolveComparisonMonth('previous', '01', ['01', '03', '04'])).toBeNull();
    expect(resolveComparisonMonth('month:03', '04', ['01', '03', '04'])).toBe('03');
    expect(resolveComparisonMonth('month:04', '04', ['01', '03', '04'])).toBeNull();
    expect(resolveComparisonMonth('month:12', '04', ['01', '03', '04'])).toBeNull();
  });

  it('renders no 2025 option and emits the selected comparison', () => {
    const onChange = vi.fn<(value: ComparisonSelection) => void>();
    render(
      <CompareSelector
        months={['01', '03', '04']}
        currentMonth="04"
        value="off"
        onChange={onChange}
      />,
    );

    expect(screen.queryByText(/2025/)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'April 2026' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Compare' }), {
      target: { value: 'previous' },
    });
    expect(onChange).toHaveBeenCalledWith('previous');
  });
});
