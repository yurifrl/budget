import { parseRich, type RichNode } from '@shared/i18n';
import { Fragment, type ReactNode } from 'react';

/** Renders the children of one tag: `(children) => <strong>{children}</strong>`. */
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
 * A translated sentence with embedded elements (React DOM twin of the client's `rich`):
 *
 *   rich(t('auth.signInBody', { url }), { link: (c) => <a href={url}>{c}</a> })
 *
 * Params are interpolated by `t` first, so a param value containing `<b>` is
 * treated as a tag: pass names, numbers and ids, not user-typed markup.
 */
export function rich(message: string, tags: Readonly<Record<string, RichRenderer>>): ReactNode {
  return <>{render(parseRich(message), tags)}</>;
}
