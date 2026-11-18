/**
 * AvatarSpec → drawing primitives (pure). The scene is a 100×100 viewBox
 * description; renderers (react-native-svg in AvatarArt.tsx, the plain SVG
 * string in svg.ts) only map nodes to elements, so geometry lives in exactly
 * one place and is unit-testable.
 */
import type { AvatarSpec } from './generate';

export const VIEWBOX = 100;

export type SceneNode =
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill: string; opacity?: number }
  | { t: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; sw?: number; opacity?: number }
  | { t: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill: string; opacity?: number }
  | { t: 'path'; d: string; fill?: string; stroke?: string; sw?: number; opacity?: number }
  | { t: 'g'; transform: string; children: SceneNode[] };

/**
 * `simple` drops fine detail (brows, blush) and thickens strokes so the face
 * still reads at 16–28px; `full` is for anything larger.
 */
export type Detail = 'full' | 'simple';

/** Pick the detail level for a rendered pixel size. */
export const detailForSize = (size: number): Detail => (size < 30 ? 'simple' : 'full');

const n = (v: number) => Math.round(v * 100) / 100;

function eyeNodes(spec: AvatarSpec, side: -1 | 1, sw: number): SceneNode {
  const { kind, spacing, y, size: r } = spec.eyes;
  const x = side * spacing;
  const ink = spec.ink;
  const arc = (d: string): SceneNode => ({ t: 'path', d, stroke: ink, sw });
  const happy = () => arc(`M ${n(x - r)} ${n(y + r * 0.45)} Q ${n(x)} ${n(y - r * 1.3)} ${n(x + r)} ${n(y + r * 0.45)}`);
  switch (kind) {
    case 'oval':
      return { t: 'ellipse', cx: x, cy: y, rx: n(r * 0.78), ry: n(r * 1.2), fill: ink };
    case 'happy':
      return happy();
    case 'sleepy':
      return arc(`M ${n(x - r)} ${n(y - r * 0.2)} Q ${n(x)} ${n(y + r * 1.1)} ${n(x + r)} ${n(y - r * 0.2)}`);
    case 'wink':
      return side === 1 ? happy() : { t: 'circle', cx: x, cy: y, r, fill: ink };
    default:
      return { t: 'circle', cx: x, cy: y, r, fill: ink };
  }
}

function mouthNode(spec: AvatarSpec, sw: number): SceneNode {
  const { kind, width: w, y, depth } = spec.mouth;
  const ink = spec.ink;
  const half = (hw: number, h: number): SceneNode => ({
    t: 'path',
    d: `M ${n(-hw)} ${n(y)} L ${n(hw)} ${n(y)} A ${n(hw)} ${n(h)} 0 0 1 ${n(-hw)} ${n(y)} Z`,
    fill: ink,
  });
  switch (kind) {
    case 'grin':
      return half(w, depth * 0.95);
    case 'open':
      return half(w * 0.62, depth * 1.1);
    case 'o':
      return { t: 'ellipse', cx: 0, cy: n(y + depth * 0.3), rx: n(w * 0.38), ry: n(depth * 0.55), fill: ink };
    case 'smirk':
      return {
        t: 'path',
        d: `M ${n(-w)} ${n(y)} Q ${n(w * 0.2)} ${n(y + depth)} ${n(w)} ${n(y - depth * 0.45)}`,
        stroke: ink,
        sw,
      };
    default:
      return { t: 'path', d: `M ${n(-w)} ${n(y)} Q 0 ${n(y + depth)} ${n(w)} ${n(y)}`, stroke: ink, sw };
  }
}

function decorNode(spec: AvatarSpec): SceneNode | null {
  const { decor, decorX: x, decorY: y, accent } = spec;
  switch (decor) {
    case 'circle':
      return { t: 'circle', cx: x, cy: y, r: 20, fill: accent, opacity: 0.85 };
    case 'ring':
      return { t: 'circle', cx: x, cy: y, r: 24, stroke: accent, sw: 9, opacity: 0.8 };
    case 'band':
      return {
        t: 'path',
        d: `M 0 ${n(y - 12)} L 100 ${n(y - 34)} L 100 ${n(y + 4)} L 0 ${n(y + 26)} Z`,
        fill: accent,
        opacity: 0.45,
      };
    default:
      return null;
  }
}

/** Build the drawing primitives for a spec at the given detail level. */
export function avatarScene(full: AvatarSpec, detail: Detail = 'full'): SceneNode[] {
  const simple = detail === 'simple';
  // Small sizes: bigger eyes so the face still reads.
  const spec: AvatarSpec = simple ? { ...full, eyes: { ...full.eyes, size: full.eyes.size * 1.18 } } : full;
  const sw = simple ? 5.4 : 4.4;
  const { size, radius, dx, dy, rotate } = spec.faceShape;
  const e = spec.eyes;

  const features: SceneNode[] = [];
  if (!simple && spec.blush) {
    for (const side of [-1, 1]) {
      features.push({
        t: 'ellipse',
        cx: n(side * (e.spacing + 9)),
        cy: n(spec.mouth.y - 4),
        rx: 6.5,
        ry: 4,
        fill: '#ff5d8f',
        opacity: 0.38,
      });
    }
  }
  features.push(eyeNodes(spec, -1, sw - 0.6), eyeNodes(spec, 1, sw - 0.6), mouthNode(spec, sw));
  if (!simple && spec.brow !== 'none') {
    for (const side of [-1, 1]) {
      const x = side * e.spacing;
      const by = e.y - e.size * 2.3;
      const r = e.size * 0.95;
      features.push({
        t: 'path',
        d:
          spec.brow === 'arch'
            ? `M ${n(x - r)} ${n(by + 1.2)} Q ${n(x)} ${n(by - 2.8)} ${n(x + r)} ${n(by + 1.2)}`
            : `M ${n(x - r)} ${n(by)} L ${n(x + r)} ${n(by)}`,
        stroke: spec.ink,
        sw: 2.8,
        opacity: 0.85,
      });
    }
  }

  const nodes: SceneNode[] = [{ t: 'rect', x: 0, y: 0, w: VIEWBOX, h: VIEWBOX, fill: spec.bg }];
  const decor = decorNode(spec);
  if (decor) nodes.push(decor);
  nodes.push({
    t: 'g',
    transform: `translate(${n(50 + dx)} ${n(50 + dy)}) rotate(${n(rotate)})`,
    children: [
      { t: 'rect', x: n(-size / 2), y: n(-size / 2), w: size, h: size, rx: radius, fill: spec.face },
      ...features,
    ],
  });
  return nodes;
}
