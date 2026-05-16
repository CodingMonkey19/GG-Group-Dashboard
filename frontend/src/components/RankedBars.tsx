interface RankedRow {
  label: string;
  value: number;
  sub: string;
}

interface Props {
  rows: RankedRow[];
  accent?: 'ink' | 'blue';
  formatValue?: (value: number) => string;
}

export function RankedBars({ rows, accent = 'ink', formatValue = String }: Props): JSX.Element {
  if (rows.length === 0) {
    return <p className="panel__empty">No rows to rank yet.</p>;
  }

  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="ranked">
      {rows.map((row, i) => (
        <li key={`${row.label}-${i}`} className="ranked__row">
          <span className="ranked__rank">{i + 1}</span>
          <span className="ranked__label">{row.label}</span>
          <span className="ranked__bar-track">
            <span
              className={`ranked__bar ranked__bar--${i === 0 ? 'lead' : accent}`}
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </span>
          <span className="ranked__value">{formatValue(row.value)}</span>
          <span className="ranked__sub">{row.sub}</span>
        </li>
      ))}
    </ol>
  );
}
