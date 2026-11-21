import { defineMessages } from '../index';
import en from './en';
import ptBR from './pt-BR';

/**
 * Message per API error code (`shared/src/errors.ts`). Typed: `tError('not_found')`.
 * For a code that arrives at runtime as a plain string, use {@link translateErrorCode}.
 */
export const tError = defineMessages('errors', en, { 'pt-BR': ptBR }, { skipUnusedCheck: true });

/** The message for `code` in the active locale, or `undefined` when this build has no entry for it. */
export function translateErrorCode(code: string, params?: Readonly<Record<string, string | number>>): string | undefined {
  if (!Object.hasOwn(en, code)) return undefined;
  return (tError as unknown as (key: string, params?: Readonly<Record<string, string | number>>) => string)(code, params);
}
