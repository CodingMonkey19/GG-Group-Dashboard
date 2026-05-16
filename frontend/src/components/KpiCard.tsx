export type KpiAccent = 'paid' | 'unpaid';
export type KpiDeltaDir = 'up' | 'down';

interface Props {
  label: string;
  value: string;
  sub: string;
  accent?: KpiAccent;
  delta?: string;
  deltaDir?: KpiDeltaDir;
  /**
   * Hover tooltip text. When set, a small `ⓘ` is rendered next to the label
   * and the root `.kpi` div carries `title={tooltip}` for a native browser
   * tooltip. Operator can read the metric definition without leaving the row.
   */
  tooltip?: string;
}

export function KpiCard({
  label,
  value,
  sub,
  accent,
  delta,
  deltaDir = 'up',
  tooltip,
}: Props): JSX.Element {
  const className = `kpi${accent ? ` kpi--${accent}` : ''}`;
  return (
    <div className={className} title={tooltip}>
      <div className="kpi__head">
        <span className="kpi__label">
          {label}
          {tooltip && (
            <span className="kpi__hint" aria-hidden="true">
              ⓘ
            </span>
          )}
        </span>
        {delta && (
          <span className={`kpi__delta kpi__delta--${deltaDir}`}>
            <span className="kpi__delta-arrow">▲</span> {delta}
          </span>
        )}
      </div>
      <div className="kpi__value">{value}</div>
      <div className="kpi__sub">{sub}</div>
    </div>
  );
}
