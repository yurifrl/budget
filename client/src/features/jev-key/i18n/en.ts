export default {
  // JevKeyScreen
  'screen.title': 'Jev API key',
  'screen.help':
    'Jev is the decision model that suggests a category for each transaction. It runs on OpenRouter, so it needs an OpenRouter key. The key is stored encrypted on the server and is never shown again.',

  // Card: the field (no key saved yet, or replacing one)
  'card.field': 'Jev API key',
  'card.save': 'Save key',
  'card.checking': 'Checking with Jev…',

  // Card: a server key is in use (shared-jev-key feature on, no own key)
  'card.serverKey': 'Server key in use',
  'card.serverKeyBody':
    'This server has a Jev key and your account may use it. Save your own key to use that one instead.',

  // Card: the saved state
  'card.savedSection': 'SAVED KEY',
  'card.ending': 'ends in ••••{last4}',
  'card.savedAt': 'saved {date}',
  'card.test': 'Test key',
  'card.testing': 'Testing…',
  'card.tested': 'Jev accepted this key.',
  'card.replace': 'Replace key',
  'card.removeConfirm': 'Remove the saved Jev key? Categorize runs stop until a key is saved again.',

  // Errors
  'error.required': 'Enter a Jev key.',
  'error.rejected': 'Jev refused this key. Check it in OpenRouter and save it again.',
  'error.unavailable': 'Jev is not available right now. Try again later.',
  'error.noCredits': 'The OpenRouter account behind this key has no credits left. Add credits or use another key.',
  'error.unreadable': 'Your saved key cannot be read on this server. Save it again.',
  'error.removeFailed': 'Could not remove the key.',
  'error.noEncryption': 'This server cannot store keys right now. Ask the person who runs it.',
  'error.codeMissing': 'Save a Jev key first.',
  'error.saveFailed': 'Could not save the key.',
  'error.testFailed': 'Could not test the key.',
  'error.loadFailed': 'Could not read your Jev key.',

  // useJevKey
  'hook.saved': 'Key saved. Jev accepted it.',
  'hook.removed': 'Key removed. Categorize runs need a key again.',
} as const;
