/**
 * Small icon set drawn to match the YNAB accounts toolbar reference
 * (syscd-accounts): plus-circle, file import, undo/redo arcs, view chevron
 * and the search magnifier. All go through react-native-svg so they render
 * identically on web (react-native-web) and iOS.
 */

import Svg, { Circle, Line, Path } from 'react-native-svg';

type IconProps = {
  /** Logical size; icons are drawn on a 24×24 grid and scale freely. */
  size?: number;
  color: string;
};

/** Filled disc with a knockout plus (Add Transaction / Category Group). */
export function PlusCircleIcon({ size = 16, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill={color}
        fillRule="evenodd"
        d="M12 1a11 11 0 1 0 0 22 11 11 0 1 0 0-22zM10.5 6.5h3v4h4v3h-4v4h-3v-4h-4v-3h4z"
      />
    </Svg>
  );
}

/** Document with an up arrow rising through its bottom edge (File Import). */
export function FileImportIcon({ size = 16, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M15 3H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2M14 21h2a2 2 0 0 0 2-2V9M15 3c1.1 0 2 .9 2 2v4h-2a2 2 0 0 1-2-2V3"
      />
      <Path
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M12 22v-9M8.8 16 12 12.8 15.2 16"
      />
    </Svg>
  );
}

/** Curved arrow sweeping left at the top (Undo); Redo mirrors it. */
export function UndoIcon({ size = 16, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"
      />
    </Svg>
  );
}

/** Mirror of {@link UndoIcon} (Redo). */
export function RedoIcon({ size = 16, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13"
      />
    </Svg>
  );
}

/** Small filled triangle pointing down (View menu chevron). */
export function ChevronDownIcon({ size = 9, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path fill={color} d="M4 7h16L12 19z" />
    </Svg>
  );
}

/** Search magnifier. */
export function MagnifierIcon({ size = 14, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={10.5} cy={10.5} r={6.5} stroke={color} strokeWidth={2.4} fill="none" />
      <Line x1={15.5} y1={15.5} x2={20} y2={20} stroke={color} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  );
}
