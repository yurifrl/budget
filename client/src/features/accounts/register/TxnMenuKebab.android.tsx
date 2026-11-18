/**
 * Android no-op: there is no row menu yet (the `TxnRowMenu` popup is
 * web-only, and unlike iOS the platform has no native context-menu trigger),
 * so the stub keeps Android's rows unchanged.
 */
export function TxnMenuKebab(_: {
  onOpen: (pageX: number, pageY: number) => void;
}): null {
  return null;
}
