/**
 * DonutChart — spend distribution (HANDOFF §4.7).
 *
 * Top 11 projects colored from PROJECT_PALETTE, remaining projects
 * aggregated as grey "Other (N)". Hovering a segment explodes it ~8px
 * outward and updates the center text; hovering the "Other" segment
 * pops up an HTML overlay listing every project inside it.
 *
 * Caller passes `slices` already sorted by value desc; rank-by-spend
 * order matches the palette used in StackedBars so colors are consistent.
 */

import { useState } from 'react';
import { fmtEur } from '../lib/format';
import { PROJECT_OTHER_COLOR, PROJECT_PALETTE } from '../lib/palette';

interface DonutSlice {
  label: string;
  value: number;
}

interface Props {
  slices: DonutSlice[];
  height?: number;
}

interface ArcSegment {
  d: string;
  color: string;
  label: string;
  value: number;
  pct: number;
  mid: number;
  isOther: boolean;
  others: DonutSlice[];
}

export function DonutChart({ slices, height = 540 }: Props): JSX.Element {
  const W = 1000;
  const H = height;
  const cx = 320;
  const cy = H / 2;
  const r = 240;
  const ir = 150;

  const [hover, setHover] = useState<number | null>(null);

  const total = slices.reduce((a, s) => a + s.value, 0);
  const TOP_N = PROJECT_PALETTE.length;
  const top = slices.slice(0, TOP_N);
  const rest = slices.slice(TOP_N);
  const otherVal = rest.reduce((a, s) => a + s.value, 0);

  const segs: Array<{ label: string; value: number; isOther: boolean; others: DonutSlice[] }> =
    top.map((s) => ({ label: s.label, value: s.value, isOther: false, others: [] }));
  if (otherVal > 0) {
    segs.push({
      label: `Other (${rest.length})`,
      value: otherVal,
      isOther: true,
      others: rest,
    });
  }

  // Build arc paths.
  const arcs: ArcSegment[] = [];
  let acc = 0;
  const safeTotal = total > 0 ? total : 1;
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i]!;
    const start = (acc / safeTotal) * Math.PI * 2 - Math.PI / 2;
    acc += s.value;
    const end = (acc / safeTotal) * Math.PI * 2 - Math.PI / 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(start);
    const y0 = cy + r * Math.sin(start);
    const x1 = cx + r * Math.cos(end);
    const y1 = cy + r * Math.sin(end);
    const xi0 = cx + ir * Math.cos(start);
    const yi0 = cy + ir * Math.sin(start);
    const xi1 = cx + ir * Math.cos(end);
    const yi1 = cy + ir * Math.sin(end);
    const d = `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${ir},${ir} 0 ${large} 0 ${xi0},${yi0} Z`;
    const mid = (start + end) / 2;
    const color = s.isOther ? PROJECT_OTHER_COLOR : PROJECT_PALETTE[i] ?? PROJECT_OTHER_COLOR;
    arcs.push({
      d,
      color,
      label: s.label,
      value: s.value,
      pct: s.value / safeTotal,
      mid,
      isOther: s.isOther,
      others: s.others,
    });
  }

  const activeArc = hover !== null ? arcs[hover] ?? null : null;
  const hoveringOther = activeArc !== null && activeArc.isOther;

  // Two-column legend to the right of the donut.
  const legendX = cx + r + 50;
  const colW = 180;
  const rowH = 28;
  const rowsPerCol = Math.max(1, Math.ceil(segs.length / 2));

  return (
    <div className="donut-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Spend distribution"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <filter id="donut-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
            <feOffset dx="0" dy="2" result="off" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.18" />
            </feComponentTransfer>
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {arcs.map((a, i) => {
          const isActive = hover === i;
          const dx = isActive ? Math.cos(a.mid) * 8 : 0;
          const dy = isActive ? Math.sin(a.mid) * 8 : 0;
          return (
            <path
              key={`arc-${i}`}
              d={a.d}
              fill={a.color}
              transform={`translate(${dx}, ${dy})`}
              className="donut__seg"
              opacity={hover === null || hover === i ? 1 : 0.35}
              stroke="#fff"
              strokeWidth="2"
              onMouseEnter={() => setHover(i)}
            />
          );
        })}

        <text x={cx} y={cy - 26} textAnchor="middle" className="donut__center-label">
          {activeArc !== null ? activeArc.label : 'Total spend'}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="donut__center-value">
          {activeArc !== null ? fmtEur(activeArc.value) : fmtEur(total)}
        </text>
        <text x={cx} y={cy + 40} textAnchor="middle" className="donut__center-sub">
          {activeArc !== null
            ? `${Math.round(activeArc.pct * 100)}% of total`
            : `${slices.length} ${slices.length === 1 ? 'project' : 'projects'}`}
        </text>

        <g transform={`translate(${legendX}, ${cy - (rowsPerCol * rowH) / 2})`}>
          {segs.map((s, i) => {
            const col = Math.floor(i / rowsPerCol);
            const row = i % rowsPerCol;
            const isActive = hover === i;
            const swatchColor = arcs[i]?.color ?? PROJECT_OTHER_COLOR;
            return (
              <g
                key={`legend-${i}`}
                transform={`translate(${col * colW}, ${row * rowH})`}
                className="donut__legend-row"
                onMouseEnter={() => setHover(i)}
              >
                <rect
                  width={colW - 12}
                  height="22"
                  rx="4"
                  y="-4"
                  fill={isActive ? 'rgba(14,19,32,0.04)' : 'transparent'}
                />
                <rect width="12" height="12" rx="3" y="0" fill={swatchColor} />
                <text x="22" y="11" className="donut__legend-label">
                  {s.label}
                </text>
                <text x={colW - 20} y="11" textAnchor="end" className="donut__legend-pct">
                  {Math.round((s.value / safeTotal) * 100)}%
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {hoveringOther && activeArc !== null && (
        <div className="donut__other-popup">
          <div className="donut__other-popup-head">
            <span className="donut__other-popup-title">
              Other — {activeArc.others.length}{' '}
              {activeArc.others.length === 1 ? 'project' : 'projects'}
            </span>
            <span className="donut__other-popup-total">{fmtEur(activeArc.value)}</span>
          </div>
          <ul className="donut__other-popup-list">
            {activeArc.others.map((o) => (
              <li key={o.label}>
                <span className="donut__other-popup-label">{o.label}</span>
                <span className="donut__other-popup-value">{fmtEur(o.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
