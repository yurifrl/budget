/**
 * iOS no-op: the whole row is the native context-menu trigger
 * (`TxnMenuTrigger.ios.tsx` wraps it), so there is no ⋯ kebab. The stub keeps
 * the row JSX identical across platforms.
 */
export function TxnMenuKebab(_: {
  onOpen: (pageX: number, pageY: number) => void;
}): null {
  return null;
}
