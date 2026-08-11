export type Scope = 'month' | 'year' | 'range';

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
        2026 Overall
      </button>
      <button
        type="button"
        className={`scope-toggle__btn ${value === 'range' ? 'scope-toggle__btn--active' : ''}`}
        aria-pressed={value === 'range'}
        onClick={() => onChange('range')}
      >
        Custom period
      </button>
    </div>
  );
}
