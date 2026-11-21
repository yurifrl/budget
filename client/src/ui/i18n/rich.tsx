import { parseRich, type RichNode } from '@shared/i18n';
import { Fragment, type ReactNode } from 'react';

/** Renders the children of one tag: `(children) => <Text style={bold}>{children}</Text>`. */
export type RichRenderer = (children: ReactNode) => ReactNode;

function render(nodes: readonly RichNode[], tags: Readonly<Record<string, RichRenderer>>): ReactNode[] {
  return nodes.map((node, index) => {
    if (typeof node === 'string') return <Fragment key={index}>{node}</Fragment>;
    const inner = render(node.children, tags);
    const renderer = tags[node.tag];
    // A tag with no renderer is dropped and its text kept: a typo in a catalog never hides words.
    return <Fragment key={index}>{renderer ? renderer(inner) : inner}</Fragment>;
  });
}

/**
 * A translated sentence with embedded elements:
 *
 *   t('hint.save', {})  // 'Press <b>Save</b> to keep it'
 *   <Text>{rich(t('hint.save'), { b: (c) => <Text style={s.bold}>{c}</Text> })}</Text>
 *
 * Tags are `<name>…</name>` and nest. Params are interpolated by `t` first, so a
 * param value containing `<b>` would be treated as a tag: pass names and numbers,
 * not user-typed markup.
 */
export function rich(message: string, tags: Readonly<Record<string, RichRenderer>>): ReactNode {
  return <>{render(parseRich(message), tags)}</>;
}
