export type Scope = 'month' | 'year';

interface Props {
  value: Scope;
  onChange: (scope: Scope) => void;
}

export function ScopeToggle({ value, onChange }: Props): JSX.Element {
  return (
    <div className="scope-toggle" role="group" aria-label="Reporting scope">
      <button
        type="button"
        className={`scope-toggle__btn ${value === 'month' ? 'scope-toggle__btn--active' : ''}`}
        aria-pressed={value === 'month'}
        onClick={() => onChange('month')}
      >
        Month
      </button>
      <button
        type="button"
        className={`scope-toggle__btn ${value === 'year' ? 'scope-toggle__btn--active' : ''}`}
        aria-pressed={value === 'year'}
        onClick={() => onChange('year')}
      >
        Jan–Jul 2026
      </button>
    </div>
  );
}
