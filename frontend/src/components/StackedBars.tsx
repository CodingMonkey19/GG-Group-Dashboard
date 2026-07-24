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

import { useEffect, useRef, useState, type CSSProperties } from 'react';
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
  currentMonth?: string | null;
  comparisonMonth?: string | null;
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

export function StackedBars({
  data,
  height = 320,
  currentMonth = null,
  comparisonMonth = null,
}: Props): JSX.Element {
  const W = 1000;
  const H = height;
  const padL = 64;
  const padR = 24;
  const padT = 16;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const [hover, setHover] = useState<number | null>(null);

  // Pin state: when the operator clicks a bar, the popup locks to that
  // bar at the click position. Mouse movement no longer changes which
  // month is shown or where the popup sits — they can freely scroll
  // inside it. Press Esc (or click the same bar again, or click a
  // different bar to re-pin) to release.
  const [pinned, setPinned] = useState<number | null>(null);
  const [pinnedMouse, setPinnedMouse] = useState<{ x: number; y: number } | null>(null);

  // Mouse position relative to the wrap, in pixels. The popup follows the
  // cursor (to the right) so the operator can move toward it without
  // crossing other bars. Updated only on SVG mousemove — entering the
  // popup itself freezes the position so it can be scrolled.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [mouseInWrap, setMouseInWrap] = useState<{ x: number; y: number } | null>(null);

  // Esc to unpin.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && pinned !== null) {
        setPinned(null);
        setPinnedMouse(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  const onBarClick = (i: number): void => {
    if (pinned === i) {
      // Click the already-pinned bar → unpin.
      setPinned(null);
      setPinnedMouse(null);
    } else {
      // Pin to this bar at the current cursor position.
      setPinned(i);
      setPinnedMouse(mouseInWrap);
    }
  };

  const onSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    const rect = wrap.getBoundingClientRect();
    setMouseInWrap({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const processed: ProcessedMonth[] =
    data.length > 0 ? data.map(processMonth) : [{ m: '—', total: 0, stacks: [] }];

  const max = Math.max(...processed.map((p) => p.total), 1);
  const ticks = niceTicks(max);
  const topTick = ticks[ticks.length - 1] ?? 1;

  const slot = innerW / processed.length;
  const bw = Math.min(slot * 0.62, 56);

  // `active` = the bar the popup is showing. Pin wins over hover.
  const active = pinned !== null ? pinned : hover;
  const hoveredMonth = active !== null ? processed[active] ?? null : null;

  // Build the popup positioning style. Pinned position wins over live
  // cursor; falls back to top-right when nothing is hovered.
  //
  // Edge-case handling:
  //   • Rightmost bar — popup would overflow the right edge → flip to the
  //     LEFT of the cursor. If neither side fits (very narrow chart), pin
  //     the popup to the right edge with a margin.
  //   • Leftmost bar — default to the right (always fits because the chart
  //     is much wider than 280px in normal use).
  //   • Bottom bar — popup anchored at `cursor.y - 12` would hang below
  //     the chart. Clamp the top so a `POPUP_TARGET_H`-tall popup always
  //     fits inside, and set `max-height` dynamically so very long lists
  //     scroll inside the popup instead of overflowing the chart panel.
  //   • Top bar — already covered by clamping the top to `>= POPUP_MARGIN`.
  const POPUP_W = 280;
  const POPUP_TARGET_H = 240;
  const POPUP_OFFSET = 16;
  const POPUP_MARGIN = 12;
  const popupStyle: CSSProperties = (() => {
    const pos = pinnedMouse ?? mouseInWrap;
    if (pos === null || hoveredMonth === null) {
      return { top: POPUP_MARGIN, right: POPUP_MARGIN };
    }
    const wrap = wrapRef.current;
    const wrapW = wrap?.clientWidth ?? 1000;
    const wrapH = wrap?.clientHeight ?? 320;

    // Horizontal — try right of cursor → flip left → pin to right edge.
    let left = pos.x + POPUP_OFFSET;
    if (left + POPUP_W + POPUP_MARGIN > wrapW) {
      const flipped = pos.x - POPUP_OFFSET - POPUP_W;
      left = flipped >= POPUP_MARGIN
        ? flipped
        : Math.max(POPUP_MARGIN, wrapW - POPUP_W - POPUP_MARGIN);
    }

    // Vertical — clamp so a typical-size popup fits inside the chart.
    // The CSS `max-height` is recomputed below so long lists scroll
    // inside the popup rather than running off the chart bottom.
    const desiredTop = pos.y - 12;
    const maxTop = Math.max(POPUP_MARGIN, wrapH - POPUP_TARGET_H - POPUP_MARGIN);
    const top = Math.max(POPUP_MARGIN, Math.min(maxTop, desiredTop));
    const maxHeight = Math.max(80, wrapH - top - POPUP_MARGIN);

    return { left, top, right: 'auto', maxHeight };
  })();

  return (
    // onMouseLeave on the WRAP (not the SVG) so hover persists when the
    // cursor moves from the bar to the popup overlay. The popup itself is
    // interactive (scrollable); mousemove tracking is on the SVG only so
    // the popup freezes when the cursor enters it.
    <div
      ref={wrapRef}
      className="stacked-wrap"
      onMouseLeave={() => {
        setHover(null);
        setMouseInWrap(null);
      }}
    >
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Spend per month"
        onMouseMove={onSvgMouseMove}
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
          // `isActive` and the dim styling honor the PINNED bar (if any)
          // first, then live hover. While pinned, mouse movement does
          // not change which bar shows the stack.
          const isActive = active === i;
          const isComparison = d.m === comparisonMonth;
          const isCurrent = d.m === currentMonth;
          const totalH = (d.total / topTick) * innerH;
          const barTopY = padT + innerH - totalH;

          if (!isActive) {
            return (
              <g
                key={`bar-${d.m}-${i}`}
                onMouseEnter={() => setHover(i)}
                onClick={() => onBarClick(i)}
                style={{ cursor: 'pointer' }}
              >
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
                  fill={isComparison ? 'var(--ink-4)' : 'var(--accent-2)'}
                  opacity={active === null ? 1 : 0.4}
                  rx="3"
                />
                <text
                  x={x + bw / 2}
                  y={H - 12}
                  textAnchor="middle"
                  className={`chart__axis-label${isCurrent ? ' chart__axis-label--current' : ''}${isComparison ? ' chart__axis-label--comparison' : ''}`}
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
            <g
              key={`bar-${d.m}-${i}`}
              onMouseEnter={() => setHover(i)}
              onClick={() => onBarClick(i)}
              style={{ cursor: 'pointer' }}
            >
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
                className={`chart__axis-label${isCurrent ? ' chart__axis-label--current' : ''}${isComparison ? ' chart__axis-label--comparison' : ''}`}
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
        <div className="stacked__popup" style={popupStyle}>
          <div className="stacked__popup-head">
            <span className="stacked__popup-title">
              {monthShortStr(hoveredMonth.m)} {hoveredMonth.m.split('-')[0]}
              {pinned !== null && (
                <span className="stacked__popup-pin-hint" title="Click bar or press Esc to release">
                  {' '}· pinned (Esc)
                </span>
              )}
            </span>
            <span className="stacked__popup-total">{fmtEur(hoveredMonth.total)}</span>
          </div>
          <ul className="stacked__popup-list">
            {hoveredMonth.stacks
              .slice()
              // Sort by spend descending — highest contributor first. The
              // raw `stacks` array is in global-rank order (palette-stable
              // across months); the popup needs THIS month's rank.
              .sort((a, b) => b.value - a.value)
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
