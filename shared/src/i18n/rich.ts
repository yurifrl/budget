/**
 * Tokenizer for messages with embedded elements: `'Press <b>Save</b> to keep it'`.
 * Pure; the React side (`rich()` in client/src/ui/i18n/rich.tsx) maps tags to
 * elements. Tags are `<name>` / `</name>` with `name` = letters, digits, `_`, `-`.
 * Tags nest. An unmatched or unclosed tag is kept as literal text.
 */

export type RichNode = string | { readonly tag: string; readonly children: RichNode[] };

interface Frame {
  tag: string | null;
  children: RichNode[];
}

function pushText(frame: Frame, text: string): void {
  if (text === '') return;
  const last = frame.children[frame.children.length - 1];
  if (typeof last === 'string') frame.children[frame.children.length - 1] = last + text;
  else frame.children.push(text);
}

/** Fold an unclosed frame back into its parent as literal `<tag>` text plus its children. */
function unwind(stack: Frame[], toIndex: number): void {
  while (stack.length - 1 > toIndex) {
    const frame = stack.pop() as Frame;
    const parent = stack[stack.length - 1] as Frame;
    pushText(parent, `<${frame.tag}>`);
    for (const child of frame.children) {
      if (typeof child === 'string') pushText(parent, child);
      else parent.children.push(child);
    }
  }
}

export function parseRich(message: string): RichNode[] {
  const root: Frame = { tag: null, children: [] };
  const stack: Frame[] = [root];
  const re = /<(\/?)([A-Za-z][\w-]*)>/g;
  let last = 0;
  for (let m = re.exec(message); m !== null; m = re.exec(message)) {
    pushText(stack[stack.length - 1] as Frame, message.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2] as string;
    if (!closing) {
      stack.push({ tag, children: [] });
      continue;
    }
    let idx = -1;
    for (let i = stack.length - 1; i > 0; i--) {
      if ((stack[i] as Frame).tag === tag) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      pushText(stack[stack.length - 1] as Frame, m[0]);
      continue;
    }
    unwind(stack, idx);
    const frame = stack.pop() as Frame;
    (stack[stack.length - 1] as Frame).children.push({ tag, children: frame.children });
  }
  pushText(stack[stack.length - 1] as Frame, message.slice(last));
  unwind(stack, 0);
  return root.children;
}
