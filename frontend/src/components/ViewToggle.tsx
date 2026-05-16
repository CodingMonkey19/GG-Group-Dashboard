/**
 * ViewToggle — switches the dashboard between Spend (US1+US2+US3) and
 * Websites (US4). Audit was removed per operator request: data-quality
 * findings are technical and reviewed by the developer separately, not
 * exposed in the CEO dashboard.
 */

export type View = 'spend' | 'websites';

interface Props {
  value: View;
  onChange: (view: View) => void;
}

const views: Array<{ id: View; label: string }> = [
  { id: 'spend', label: 'Spend' },
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
