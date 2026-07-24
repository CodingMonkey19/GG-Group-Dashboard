export type KpiAccent = 'paid' | 'unpaid';
export type KpiDeltaDir = 'up' | 'down' | 'flat';

export interface KpiComparison {
  label: string;
  value: string;
  delta: string;
  direction: KpiDeltaDir;
  tone: 'neutral' | 'favorable';
}

interface Props {
  label: string;
  value: string;
  sub: string;
  accent?: KpiAccent;
  comparison?: KpiComparison;
  /**
   * Hover tooltip text. When set, a small `ⓘ` is rendered next to the label
   * and the root `.kpi` div carries `title={tooltip}` for a native browser
   * tooltip. Operator can read the metric definition without leaving the row.
   */
  tooltip?: string;
  onClick?: () => void;
}

export function KpiCard({
  label,
  value,
  sub,
  accent,
  comparison,
  tooltip,
  onClick,
}: Props): JSX.Element {
  const className = `kpi${accent ? ` kpi--${accent}` : ''}${onClick ? ' kpi--clickable' : ''}`;
  const content = (
    <>
      <div className="kpi__head">
        <span className="kpi__label">
          {label}
          {tooltip && (
            <span className="kpi__hint" aria-hidden="true">
              ⓘ
            </span>
          )}
        </span>
      </div>
      <div className="kpi__value">{value}</div>
      <div className="kpi__sub">{sub}</div>
      {comparison !== undefined && (
        <div className="kpi__comparison">
          <span className="kpi__comparison-copy">
            {comparison.label} · <strong>{comparison.value}</strong>
          </span>
          <span
            className={`kpi__delta kpi__delta--${comparison.tone} kpi__delta--${comparison.direction}`}
          >
            {comparison.delta}
          </span>
        </div>
      )}
    </>
  );

  if (onClick !== undefined) {
    return (
      <button type="button" className={className} title={tooltip} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={className} title={tooltip}>{content}</div>;
}
