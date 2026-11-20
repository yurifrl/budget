import { createElement, type FormEvent, type ReactNode } from 'react';

/**
 * Web: a real <form> so browsers and password managers see a sign-in /
 * password-change form (and offer to save or update the password). Enter is
 * already handled by the inputs' onSubmitEditing and the buttons are not
 * type=submit, so the native submit never fires twice; onSubmit only stops
 * the browser from navigating if it ever does.
 */
export function FormWrap({ children }: { children: ReactNode; onSubmit?: () => void }) {
  return createElement(
    'form',
    {
      onSubmit: (e: FormEvent) => e.preventDefault(),
      style: { display: 'flex', flexDirection: 'column', gap: 12 },
    },
    children,
  );
}
