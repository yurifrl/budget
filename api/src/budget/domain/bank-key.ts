/**
 * A comparable key for the bank behind an account (budget-zkts), from the
 * labels providers give it: `accounts.institution` or the connection's
 * institution ("Itaú Unibanco PF", "itau", "Nu Pagamentos S.A.", "Nubank").
 * Known brands map to one key; anything else is the label without accents,
 * punctuation and company suffixes. Null when there is no usable label.
 */

const BRANDS: readonly [RegExp, string][] = [
  [/\bnu ?(bank|pagamentos|financeira|invest)\b|^nu$/, 'nubank'],
  [/\bitau/, 'itau'],
  [/\bbradesco/, 'bradesco'],
  [/\bsantander/, 'santander'],
  [/\bcaixa\b|\bcef\b/, 'caixa'],
  [/\bbanco do brasil\b|^bb\b/, 'bb'],
  [/\binter\b|\bintermedium\b/, 'inter'],
  [/\bc6\b/, 'c6'],
  [/\bbtg\b/, 'btg'],
  [/\bxp\b/, 'xp'],
  [/\bpicpay\b/, 'picpay'],
  [/\bmercado ?pago\b/, 'mercadopago'],
  [/\bpag ?bank\b|\bpagseguro\b/, 'pagbank'],
  [/\bsicoob\b/, 'sicoob'],
  [/\bsicredi\b/, 'sicredi'],
];

const NOISE = /\b(s ?a|ltda|pf|pj|banco|bank|unibanco|instituicao de pagamento|me|epp)\b/g;

export function bankKey(label: string | null | undefined): string | null {
  const plain = (label ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (plain === '') return null;
  for (const [pattern, key] of BRANDS) if (pattern.test(plain)) return key;
  const rest = plain.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  return rest === '' ? plain : rest;
}
