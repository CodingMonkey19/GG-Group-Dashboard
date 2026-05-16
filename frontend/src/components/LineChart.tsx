/**
 * LineChart — links-built-per-month trend (HANDOFF §4.5).
 *
 * Adds Y-axis tick labels, hit-rect hover overlays, a dashed vertical
 * hover line, and a tooltip box with month + count + % vs previous.
 *
 * Pure SVG, no chart library. `data` and `labels` are parallel arrays
 * supplied by the caller (typically App.tsx via `rowsDoneSeries`).
 */

import { useState } from 'react';
import { fmtNum } from '../lib/format';

interface Props {
  data: number[];
  labels: string[];
  height?: number;
}

interface NiceTicksOptions {
  count?: number;
}

function niceTicks(maxVal: number, options: NiceTicksOptions = {}): number[] {
  const count = options.count ?? 4;
  if (maxVal <= 0) return [0];
  const rough = maxVal / count;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * pow;
  const top = Math.ceil(maxVal / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 0.0001; v += step) out.push(v);
  return out;
}

export function LineChart({ data, labels, height = 280 }: Props): JSX.Element {
  const W = 1000;
  const H = height;
  const padL = 56;
  const padR = 24;
  const padT = 16;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const [hover, setHover] = useState<number | null>(null);

  const values = data.length > 0 ? data : [0];
  const safeLabels = labels.length === values.length ? labels : values.map(() => '');
  const max = Math.max(...values);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] ?? 1;
  const step = values.length > 1 ? innerW / (values.length - 1) : innerW;
  const points: Array<[number, number]> = values.map((v, i) => [
    padL + i * step,
    padT + innerH - (v / Math.max(top, 1)) * innerH,
  ]);
  const path = points
    .map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`))
    .join(' ');
  const first = points[0] ?? [padL, padT + innerH];
  const last = points[points.length - 1] ?? first;
  const area = `${path} L${last[0]},${padT + innerH} L${first[0]},${padT + innerH} Z`;
  const xEvery = Math.max(1, Math.ceil(values.length / 8));

  function tooltipMeta(i: number): { v: number; delta: number | null } {
    const v = values[i] ?? 0;
    const prev = i > 0 ? values[i - 1] ?? null : null;
    const delta = prev !== null && prev > 0 ? Math.round(((v - prev) / prev) * 100) : null;
    return { v, delta };
  }

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Links built per month"
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <linearGradient id="line-area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(44,99,214,0.28)" />
          <stop offset="100%" stopColor="rgba(44,99,214,0)" />
        </linearGradient>
      </defs>

      {ticks.map((t, i) => {
        const y = padT + innerH - (t / Math.max(top, 1)) * innerH;
        return (
          <g key={`tick-${i}`}>
            <line x1={padL} x2={W - padR} y1={y} y2={y} className="chart__grid" />
            <text x={padL - 8} y={y + 4} textAnchor="end" className="chart__axis-label">
              {fmtNum(t)}
            </text>
          </g>
        );
      })}

      <path d={area} className="chart__area" style={{ fill: 'url(#line-area-grad)' }} />
      <path d={path} className="chart__line" />

      {points.map((p, i) => (
        <circle
          key={`dot-${i}`}
          cx={p[0]}
          cy={p[1]}
          r={hover === i ? 5.5 : 3}
          className="chart__dot"
        />
      ))}

      {safeLabels.map((lbl, i) => {
        if (i % xEvery !== 0 && i !== safeLabels.length - 1) return null;
        const p = points[i];
        if (p === undefined) return null;
        return (
          <text
            key={`xlabel-${i}`}
            x={p[0]}
            y={H - 12}
            textAnchor="middle"
            className="chart__axis-label"
          >
            {lbl}
          </text>
        );
      })}

      {points.map((p, i) => (
        <rect
          key={`hit-${i}`}
          x={p[0] - step / 2}
          y={padT}
          width={step}
          height={innerH}
          fill="transparent"
          onMouseEnter={() => setHover(i)}
        />
      ))}

      {hover !== null && points[hover] !== undefined && (() => {
        const p = points[hover]!;
        const { v, delta } = tooltipMeta(hover);
        const tipW = 170;
        const tipH = delta !== null ? 64 : 44;
        const tipX = Math.min(W - padR - tipW, Math.max(padL, p[0] - tipW / 2));
        const tipY = Math.max(padT, p[1] - tipH - 12);
        const label = safeLabels[hover] ?? `Point ${hover + 1}`;
        return (
          <g pointerEvents="none">
            <line
              x1={p[0]}
              x2={p[0]}
              y1={padT}
              y2={padT + innerH}
              className="chart__hover-line"
            />
            <g transform={`translate(${tipX}, ${tipY})`}>
              <rect width={tipW} height={tipH} rx="8" className="chart__tip-bg" />
              <text x="12" y="18" className="chart__tip-label">
                {label}
              </text>
              <text x="12" y="38" className="chart__tip-value">
                {fmtNum(v)} links
              </text>
              {delta !== null && (
                <text
                  x="12"
                  y="56"
                  className={`chart__tip-delta chart__tip-delta--${delta >= 0 ? 'up' : 'down'}`}
                >
                  {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}% vs previous
                </text>
              )}
            </g>
          </g>
        );
      })()}
    </svg>
  );
}
