import { translateErrorCode } from '@shared/i18n/errors';

/**
 * A server sentence stored with a bank connection or a sync run
 * (`status_message`, `user_message`), shown in the active language: the
 * message for its `server_*` code when this build has one, else the stored
 * text as it came.
 */
export function storedServerMessage(text: string | null | undefined, code: string | null | undefined): string | null {
  const translated = code ? translateErrorCode(code) : undefined;
  return translated ?? text ?? null;
}
