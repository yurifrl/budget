/**
 * react-native-svg painter for a generated avatar. Pure presentation: all
 * geometry comes from scene.ts, so this only maps primitives to elements.
 * Draws a full square; the caller (Avatar) clips it to a circle.
 */
import { memo, useMemo } from 'react';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';

import { generateAvatar } from './generate';
import { avatarScene, detailForSize, VIEWBOX, type SceneNode } from './scene';

function renderNode(node: SceneNode, key: number) {
  switch (node.t) {
    case 'rect':
      return <Rect key={key} x={node.x} y={node.y} width={node.w} height={node.h} rx={node.rx} fill={node.fill} opacity={node.opacity} />;
    case 'circle':
      return (
        <Circle key={key} cx={node.cx} cy={node.cy} r={node.r} fill={node.fill ?? 'none'} stroke={node.stroke} strokeWidth={node.sw} opacity={node.opacity} />
      );
    case 'ellipse':
      return <Ellipse key={key} cx={node.cx} cy={node.cy} rx={node.rx} ry={node.ry} fill={node.fill} opacity={node.opacity} />;
    case 'path':
      return (
        <Path key={key} d={node.d} fill={node.fill ?? 'none'} stroke={node.stroke} strokeWidth={node.sw} strokeLinecap="round" opacity={node.opacity} />
      );
    case 'g':
      return (
        <G key={key} transform={node.transform}>
          {node.children.map(renderNode)}
        </G>
      );
  }
}

export const AvatarArt = memo(function AvatarArt({ seed, size }: { seed: string; size: number }) {
  const nodes = useMemo(() => avatarScene(generateAvatar(seed), detailForSize(size)), [seed, size]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
      {nodes.map(renderNode)}
    </Svg>
  );
});
