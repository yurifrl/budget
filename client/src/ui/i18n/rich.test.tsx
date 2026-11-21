import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactNode } from 'react';

import { rich } from './rich';

/** Minimal static renderer: host elements as `<tag>…</tag>`, fragments and arrays flattened. */
function html(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(html).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    const inner = html(node.props.children);
    return typeof node.type === 'string' ? `<${node.type}>${inner}</${node.type}>` : inner;
  }
  return '';
}

describe('rich', () => {
  test('maps tags to elements and keeps surrounding text', () => {
    expect(html(rich('Press <b>Save</b> to keep it', { b: (c) => <strong>{c}</strong> }))).toBe(
      'Press <strong>Save</strong> to keep it',
    );
  });

  test('nests tags', () => {
    const out = html(rich('<b>a <i>b</i></b>', { b: (c) => <strong>{c}</strong>, i: (c) => <em>{c}</em> }));
    expect(out).toBe('<strong>a <em>b</em></strong>');
  });

  test('a tag with no renderer keeps its text', () => {
    expect(html(rich('x <u>y</u> z', {}))).toBe('x y z');
  });

  test('plain text passes through', () => {
    expect(html(rich('just text', {}))).toBe('just text');
  });
});
