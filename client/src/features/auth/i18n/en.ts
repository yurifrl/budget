export default {
  // Failures of the password requests (failureMessage and the form checks).
  'failure.generic': 'Something went wrong. Please try again.',
  'failure.network': 'Can’t reach the server. Check your connection and try again.',
  'failure.tooManyAttempts': 'Too many attempts. Wait a few minutes and try again.',
  'failure.tooManyAttemptsWait': 'Too many attempts. Try again in {wait}.',
  'failure.wrongPassword': 'The current password is not right.',
  'failure.wrongCredentials': 'Wrong e-mail or password.',
  'failure.tempExpired': 'Your temporary password has expired. Ask the administrator for a new one.',
  'failure.changeLinkExpired':
    'The time to choose a new password ran out. Sign in again with your temporary password. If it has expired, ask the administrator for a new one.',
  'failure.forbidden':
    'Your password can’t be changed from this kind of session. Sign out, sign in with your e-mail and password, and try again.',
  'failure.originNotAllowed': 'Signing in is not allowed from this address.',
  'failure.enterCredentials': 'Enter your e-mail and password.',
  'failure.checkForm': 'Check the form and try again.',
  'form.passwordMismatch': 'The two passwords don’t match.',
  'form.enterCurrent': 'Enter your current password.',

  // Waits ("Try again in 2 minutes"), rounded up.
  'wait.seconds': { one: '{count} second', other: '{count} seconds' },
  'wait.minutes': { one: '{count} minute', other: '{count} minutes' },
  'wait.hours': { one: '{count} hour', other: '{count} hours' },

  // Landing page.
  'landing.headline': 'One budget for the whole household.',
  'landing.body':
    'Plan each month, keep your accounts up to date and see where the money goes, together with the people you share a budget with.',
  'landing.footnote': 'There is no sign-up. Use the login you already have.',
  'landing.unreachableHeadline': 'Can’t reach the API',
  'landing.unreachableBody': 'No answer from {url}. Retrying automatically.',
  'landing.retry': 'Retry now',
  'landing.orEmail': 'or sign in with e-mail',
  'landing.changeHeadline': 'Choose a new password.',
  'landing.changeBody':
    'You signed in with a temporary password. Choose your own to continue. Use at least {min} characters; a few ordinary words strung together work well.',

  // Sign-in buttons and notices.
  'button.signIn': 'Sign in',
  'button.signInGoogle': 'Sign in with Google',
  'notice.accessRetry': 'Automatic sign-in with Cloudflare Access did not complete. Try again.',
  'notice.cancelled': 'Sign-in cancelled.',
  'notice.failed': 'Sign-in failed. Please try again.',

  // Password forms.
  'form.email': 'E-mail',
  'form.password': 'Password',
  'form.signIn': 'Sign in with e-mail',
  'form.newPassword': 'New password',
  'form.repeatPassword': 'Repeat the new password',
  'form.setPassword': 'Set password and sign in',
  'form.backToSignIn': 'Back to sign in',
} as const;
