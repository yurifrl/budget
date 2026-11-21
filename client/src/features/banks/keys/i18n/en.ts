export default {
  // pluggyKeys.logic.ts: form checks and save / remove errors
  'form.clientIdRequired': 'Enter the client id from your Pluggy application.',
  'form.clientSecretRequired': 'Enter the client secret from your Pluggy application.',
  'form.invalidCredentials':
    'Pluggy did not accept this client id and secret. Check both (copy them again from your application) and try again.',
  'form.keyMissing':
    'This server cannot store keys yet (its encryption key is not set up). Ask the admin, then try again.',
  'form.inputFallback': 'Check the client id and secret.',
  'form.secretInvalid': 'The client secret is too long or empty.',
  'form.clientIdInvalid': 'The client id is too long or empty.',
  'form.unreachable': 'Could not reach the server. Check your connection and try again.',
  'form.saveFailed': 'Could not save your keys. Try again.',
  'form.removeFailed': 'Could not remove your keys. Try again.',

  // pluggyKeys.logic.ts: what a paused connection tells its owner
  'paused.ownWhy': 'Paused: the Pluggy keys this bank was connected with are no longer saved.',
  'paused.ownTodo': 'Save the same client id and secret again on Your Pluggy keys and it resumes by itself.',
  'paused.ownAction': 'Your Pluggy keys',
  'paused.sharedWhy':
    "Paused: this bank uses the app's shared Pluggy keys, which are not available for your account. Add your own Pluggy keys and connect the bank again.",
  'paused.sharedTodo': 'Or ask the admin to turn the shared keys back on for you: the bank then resumes by itself.',
  'paused.sharedAction': 'Add your Pluggy keys',

  // PluggyKeysCard
  'card.loadFailed': 'Could not load your keys.',
  'card.yourKeys': 'YOUR KEYS',
  'card.clientId': 'Client id',
  'card.clientSecret': 'Client secret',
  'card.secretSaved': 'Saved (hidden)',
  'card.savedAt': 'Saved {stamp}',
  'card.removeConfirm':
    'Remove your keys? Banks connected with them stop syncing (paused, not deleted) until you save the same keys again.',
  'card.removing': 'Removing…',
  'card.removeKeys': 'Remove keys',
  'card.replaceKeys': 'Replace keys',
  'card.replaceTitle': 'REPLACE YOUR KEYS',
  'card.addTitle': 'ADD YOUR KEYS',
  'card.clientIdPlaceholder': 'e.g. 3f2a…',
  'card.secretPlaceholderNew': 'Paste the new secret',
  'card.secretPlaceholder': 'Paste the secret',
  'card.secretHint': 'Pluggy checks the pair before it is saved. The secret is stored encrypted and never shown again.',
  'card.checking': 'Checking with Pluggy…',
  'card.saveKeys': 'Save keys',

  // PluggyKeysHelp
  'help.title': 'HOW TO GET YOUR KEYS',
  'help.intro': 'The app reaches your bank through Pluggy, using keys that belong to you. Getting them takes a few minutes:',
  'help.step1':
    'Sign up for free at <link>dashboard.pluggy.ai</link>. This is MeuPluggy, Pluggy’s free route for personal use.',
  'help.step2': 'Create an application in the dashboard.',
  'help.step3':
    'Copy its client id and client secret and paste them here. Pluggy shows the secret only once, so paste it straight away (lost it? create a new one there).',
  'help.step4': 'Then connect your bank here: in the connect window, pick MeuPluggy and sign in to it.',
  'help.limit': 'MeuPluggy allows up to {limit} bank connections.',

  // usePluggyKeys
  'hook.saved': 'Keys saved. Pluggy accepted them.',
  'hook.removed': 'Keys removed. Banks connected with them are paused until you save the same keys again.',
} as const;
