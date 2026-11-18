/**
 * Plain SVG-string serializer for a scene (pure). Used by tests and by tooling
 * that needs a standalone image of an avatar (contact sheets, exports); the
 * app itself paints scenes with react-native-svg (AvatarArt.tsx).
 */
import type { AvatarSpec } from './generate';
import { avatarScene, VIEWBOX, type Detail, type SceneNode } from './scene';

const attrs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');

function nodeToSvg(node: SceneNode): string {
  switch (node.t) {
    case 'rect':
      return `<rect${attrs({ x: node.x, y: node.y, width: node.w, height: node.h, rx: node.rx, fill: node.fill, opacity: node.opacity })}/>`;
    case 'circle':
      return `<circle${attrs({ cx: node.cx, cy: node.cy, r: node.r, fill: node.fill ?? 'none', stroke: node.stroke, 'stroke-width': node.sw, opacity: node.opacity })}/>`;
    case 'ellipse':
      return `<ellipse${attrs({ cx: node.cx, cy: node.cy, rx: node.rx, ry: node.ry, fill: node.fill, opacity: node.opacity })}/>`;
    case 'path':
      return `<path${attrs({ d: node.d, fill: node.fill ?? 'none', stroke: node.stroke, 'stroke-width': node.sw, 'stroke-linecap': node.stroke ? 'round' : undefined, opacity: node.opacity })}/>`;
    case 'g':
      return `<g${attrs({ transform: node.transform })}>${node.children.map(nodeToSvg).join('')}</g>`;
  }
}

/** Standalone, circle-clipped SVG document for an avatar spec. */
export function avatarSvg(spec: AvatarSpec, size = 96, detail: Detail = 'full'): string {
  const id = `c${Math.abs(hashId(spec.bg + spec.face + spec.faceShape.rotate))}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">` +
    `<clipPath id="${id}"><circle cx="50" cy="50" r="50"/></clipPath>` +
    `<g clip-path="url(#${id})">${avatarScene(spec, detail).map(nodeToSvg).join('')}</g></svg>`
  );
}

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
