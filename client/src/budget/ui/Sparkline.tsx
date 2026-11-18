/**
 * Sparkline — an isolated, config-driven inline trend line (react-native-svg,
 * renders identically on web and iOS). Purely presentational: it takes raw
 * numbers and never knows where they came from, so any screen can chart any
 * series (bank-connection activity, balances, cashflow) without importing
 * domain code. All appearance knobs are optional; growth/decline coloring is
 * the caller's decision via the two color props.
 */

import { useMemo } from 'react';
import Svg, { Path } from 'react-native-svg';

import { colors } from './theme';

export interface SparklineProps {
  /** y values left→right, in any consistent unit; shape is all that renders. */
  points: number[];
  /** Rendered size — callers size it, the component never flexes. */
  width: number;
  height: number;
  /** Stroke color; defaults to the theme accent (indigo2). */
  color?: string;
  /** Area fill under the line; null disables the fill entirely. */
  fill?: string | null;
  /** Area opacity when `fill` is set (default 0.16). */
  fillOpacity?: number;
  /** Stroke width in view units (default 1.5). */
  strokeWidth?: number;
  /** Corners between points: straight (default) or smoothed curve. */
  curve?: 'linear' | 'smooth';
}

/** Catmull-Rom → cubic Bézier control points; falls back to straight lines. */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

export function Sparkline({
  points,
  width,
  height,
  color = colors.indigo2,
  fill = colors.indigo2,
  fillOpacity = 0.16,
  strokeWidth = 1.5,
  curve = 'linear',
}: SparklineProps) {
  const geometry = useMemo(() => {
    const values = points.filter((v) => Number.isFinite(v));
    const pad = strokeWidth / 2 + 1;
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    // Two plot variants: symmetric around zero (mix of signs) and
    // bottom-anchored (single sign or flat) — both keep the line inside the
    // padded box so a 1px stroke never clips.
    const symmetric = min < 0 && max > 0;
    const y = (v: number) => {
      if (symmetric) return height / 2 - (v / Math.max(Math.abs(min), Math.abs(max))) * (height / 2 - pad);
      const t = (v - min) / span;
      return height - pad - t * (height - pad * 2);
    };
    const step = width / (values.length - 1);
    const pts = values.map((v, i) => ({ x: i * step, y: y(v) }));
    return { pts };
  }, [points, width, height, strokeWidth]);

  if (!geometry) return null;
  const { pts } = geometry;
  const line = curve === 'smooth' ? smoothPath(pts) : pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {fill ? (
        <Path d={`${line} L${width} ${height} L0 ${height} Z`} fill={fill} fillOpacity={fillOpacity} stroke="none" />
      ) : null}
      <Path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
