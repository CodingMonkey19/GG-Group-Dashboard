/**
 * StackedBars — per-month spend (HANDOFF §4.6).
 *
 * Default state: each month renders as a single solid bar in `--accent-2`.
 * On hover, the active month's bar splits into a colored stack (top 11
 * projects from PROJECT_PALETTE + grey "Other (N)" for the tail), and an
 * HTML popup in the top-right of the chart body lists every contributor.
 *
 * Props are `MonthBreakdown[]` from `monthlyBreakdowns()`. Each entry's
 * `byProject` is already in GLOBAL project-rank order, so palette indexing
 * lines up between StackedBars and DonutChart.
 */

import { useState } from 'react';
import {
  PROJECT_OTHER_COLOR,
  PROJECT_PALETTE,
  TOP_N_FOR_PALETTE,
} from '../lib/palette';
import { fmtEur } from '../lib/format';
import type { MonthBreakdown } from '../lib/selectors';

interface Props {
  data: MonthBreakdown[];
  height?: number;
}

interface Stack {
  code: string;
  value: number;
  color: string;
}

interface ProcessedMonth {
  m: string;
  total: number;
  stacks: Stack[];
}

const MONTH_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function niceTicks(maxVal: number, count = 4): number[] {
  if (maxVal <= 0) return [0];
  const rough = maxVal / count;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * pow;
  const topTick = Math.ceil(maxVal / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= topTick + 0.0001; v += step) out.push(v);
  return out;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `€${Math.round(n / 1_000)}k`;
  return `€${Math.round(n)}`;
}

function monthShortStr(m: string): string {
  const parts = m.split('-');
  const mo = parts[1];
  const idx = mo !== undefined ? Number.parseInt(mo, 10) : 0;
  if (!Number.isFinite(idx) || idx < 1 || idx > 12) return m;
  return MONTH_SHORT[idx] ?? m;
}

function processMonth(d: MonthBreakdown): ProcessedMonth {
  const top = d.byProject.slice(0, TOP_N_FOR_PALETTE);
  const rest = d.byProject.slice(TOP_N_FOR_PALETTE);
  const otherSum = rest.reduce((a, p) => a + p.value, 0);
  const stacks: Stack[] = top.map((p, i) => ({
    code: p.code,
    value: p.value,
    color: PROJECT_PALETTE[i] ?? PROJECT_OTHER_COLOR,
  }));
  if (otherSum > 0) {
    stacks.push({
      code: `Other (${rest.length})`,
      value: otherSum,
      color: PROJECT_OTHER_COLOR,
    });
  }
  const total = stacks.reduce((a, s) => a + s.value, 0);
  return { m: d.m, total, stacks };
}

export function StackedBars({ data, height = 320 }: Props): JSX.Element {
  const W = 1000;
  const H = height;
  const padL = 64;
  const padR = 24;
  const padT = 16;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const [hover, setHover] = useState<number | null>(null);

  const processed: ProcessedMonth[] =
    data.length > 0 ? data.map(processMonth) : [{ m: '—', total: 0, stacks: [] }];

  const max = Math.max(...processed.map((p) => p.total), 1);
  const ticks = niceTicks(max);
  const topTick = ticks[ticks.length - 1] ?? 1;

  const slot = innerW / processed.length;
  const bw = Math.min(slot * 0.62, 56);

  const hoveredMonth = hover !== null ? processed[hover] ?? null : null;

  return (
    <div className="stacked-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Spend per month"
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => {
          const y = padT + innerH - (t / topTick) * innerH;
          return (
            <g key={`tick-${i}`}>
              <line x1={padL} x2={W - padR} y1={y} y2={y} className="chart__grid" />
              <text x={padL - 8} y={y + 4} textAnchor="end" className="chart__axis-label">
                {fmtK(t)}
              </text>
            </g>
          );
        })}

        {processed.map((d, i) => {
          const x = padL + i * slot + (slot - bw) / 2;
          const isActive = hover === i;
          const totalH = (d.total / topTick) * innerH;
          const barTopY = padT + innerH - totalH;

          if (!isActive) {
            return (
              <g key={`bar-${d.m}-${i}`} onMouseEnter={() => setHover(i)}>
                <rect
                  x={padL + i * slot}
                  y={padT}
                  width={slot}
                  height={innerH}
                  fill="transparent"
                />
                <rect
                  x={x}
                  y={barTopY}
                  width={bw}
                  height={totalH}
                  fill="var(--accent-2)"
                  opacity={hover === null ? 1 : 0.4}
                  rx="3"
                />
                <text
                  x={x + bw / 2}
                  y={H - 12}
                  textAnchor="middle"
                  className="chart__axis-label"
                >
                  {monthShortStr(d.m)}
                </text>
                <text
                  x={x + bw / 2}
                  y={barTopY - 6}
                  textAnchor="middle"
                  className="chart__bar-value"
                >
                  {fmtK(d.total)}
                </text>
              </g>
            );
          }

          // Active month: render the colored stack bottom-up.
          let yCursor = padT + innerH;
          const segs = d.stacks.map((s, si) => {
            const h = (s.value / topTick) * innerH;
            yCursor -= h;
            return {
              x,
              y: yCursor,
              w: bw,
              h,
              color: s.color,
              code: s.code,
              rx: si === 0 ? 3 : 0,
            };
          });
          return (
            <g key={`bar-${d.m}-${i}`} onMouseEnter={() => setHover(i)}>
              <rect
                x={padL + i * slot}
                y={padT}
                width={slot}
                height={innerH}
                fill="transparent"
              />
              {segs.map((seg, si) => (
                <rect
                  key={`seg-${i}-${si}`}
                  x={seg.x}
                  y={seg.y}
                  width={seg.w}
                  height={seg.h}
                  fill={seg.color}
                  rx={seg.rx}
                />
              ))}
              <text
                x={x + bw / 2}
                y={H - 12}
                textAnchor="middle"
                className="chart__axis-label"
              >
                {monthShortStr(d.m)}
              </text>
              <text
                x={x + bw / 2}
                y={barTopY - 6}
                textAnchor="middle"
                className="chart__bar-value"
              >
                {fmtK(d.total)}
              </text>
            </g>
          );
        })}
      </svg>

      {hoveredMonth !== null && hoveredMonth.total > 0 && (
        <div className="stacked__popup">
          <div className="stacked__popup-head">
            <span className="stacked__popup-title">
              {monthShortStr(hoveredMonth.m)} {hoveredMonth.m.split('-')[0]}
            </span>
            <span className="stacked__popup-total">{fmtEur(hoveredMonth.total)}</span>
          </div>
          <ul className="stacked__popup-list">
            {hoveredMonth.stacks
              .slice()
              .reverse()
              .map((s, i) => (
                <li key={`${s.code}-${i}`}>
                  <span className="stacked__popup-swatch" style={{ background: s.color }} />
                  <span className="stacked__popup-label">{s.code}</span>
                  <span className="stacked__popup-value">{fmtEur(s.value)}</span>
                  <span className="stacked__popup-pct">
                    {hoveredMonth.total > 0
                      ? Math.round((s.value / hoveredMonth.total) * 100)
                      : 0}
                    %
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
