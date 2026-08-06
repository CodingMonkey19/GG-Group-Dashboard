/**
 * ViewToggle — switches between the executive Spend, Savings, and Live URLs views.
 */

export type View = 'spend' | 'savings' | 'websites';

interface Props {
  value: View;
  onChange: (view: View) => void;
}

const views: Array<{ id: View; label: string }> = [
  { id: 'spend', label: 'Spend' },
  { id: 'savings', label: 'Savings' },
  { id: 'websites', label: 'Live URLs' },
];

export function ViewToggle({ value, onChange }: Props): JSX.Element {
  return (
    <nav className="view-toggle" role="tablist" aria-label="Top-level view">
      {views.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          className={`view-toggle__btn ${value === v.id ? 'view-toggle__btn--active' : ''}`}
          aria-selected={value === v.id}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </nav>
  );
}
