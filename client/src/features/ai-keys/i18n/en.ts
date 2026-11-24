export default {
  // AiKeysScreen
  'screen.title': 'AI key',
  'screen.intro':
    'Category suggestions can use an AI provider. Your key is sent to our server and stored there encrypted; it is never shown again and is not saved on this device.',
  'screen.loadFailed': 'Could not load your AI key.',

  // AiKeySavedCard: the own credential as shown back (never the key)
  'state.ownTitle': 'YOUR AI KEY',
  'state.provider': 'Provider',
  'state.model': 'Model',
  'state.none': 'Not chosen',
  'state.noModel': 'No model chosen yet. Replace the key to pick one.',
  'state.unreadable':
    'This saved key can no longer be opened on this server (the encryption key may have changed). Save the key again.',
  'state.savedAt': 'Saved {date}',
  'state.test': 'Test key',
  'state.testing': 'Testing…',
  'state.replace': 'Replace key',
  'state.remove': 'Remove key',
  'state.removeConfirm':
    'Remove your AI key? Category suggestions stop until you save one again, or the shared AI of this server is available for your account.',
  'state.removing': 'Removing…',
  'state.testOk': {
    one: 'Key accepted: {count} model available at {provider}.',
    other: 'Key accepted: {count} models available at {provider}.',
  },

  // Shared server AI (feature shared-ai-key)
  'shared.title': 'SHARED SERVER AI',
  'shared.body':
    'This server provides a shared AI key: {provider}, model {model}. Add your own key below to use it instead — yours wins.',
  'shared.bodyNoModel':
    'This server provides a shared AI key. Add your own key below to use it instead — yours wins.',

  // AiKeyForm: paste key, detect or choose the provider, pick a model
  'form.addTitle': 'ADD YOUR AI KEY',
  'form.replaceTitle': 'REPLACE YOUR AI KEY',
  'form.keyLabel': 'API key',
  'form.keyPlaceholder': 'Paste your API key',
  'form.keyHint': 'Stored encrypted on our server and never shown again. Not saved on this device.',
  'form.detecting': 'Detecting provider…',
  'form.providerLabel': 'Provider',
  'form.providerUnknown': 'Could not tell which provider this key belongs to. Choose one below.',
  'form.providerRequired': 'Choose a provider before saving.',
  'form.detected': 'Detected from the key: {provider}. You can change it.',
  'form.providerDiffers': 'The key looks like {detected}, but {chosen} is selected.',
  'form.providerChosen': 'Pick the provider this key belongs to.',
  'form.modelLabel': 'Model',
  'form.modelPlaceholder': 'Search models',
  'form.modelsLoading': 'Loading models…',
  'form.modelsEmpty': 'This provider returned no models.',
  'form.manualModelHint':
    'The model list could not be loaded. Type a model id if you know one, or save the key without a model.',
  'form.zaiTypedHint': 'Z.ai has no model list: these are suggestions. Type any model id to use it.',
  'form.useTypedModel': 'Use "{model}"',
  'form.saveWithoutModel': 'No model chosen — you can save the key without one.',
  'form.keyTooShort': 'The key looks too short. Paste the whole key.',
  'form.save': 'Save key',
  'form.saving': 'Checking and saving…',

  'notice.saved': 'Key saved and checked with {provider}.',
  'notice.removed': 'Key removed.',

  // Provider names are brands: identical in every language.
  'provider.openrouter': 'OpenRouter',
  'provider.anthropic': 'Anthropic',
  'provider.openai': 'OpenAI',
  'provider.zai': 'Z.ai',
  'provider.deepseek': 'DeepSeek',

  // One message per AI error code (shared/src/contracts/ai/credentials.ts) plus transport failures.
  'error.keyRejected': 'The AI provider did not accept this key. Check it and try again.',
  'error.providerUnknown': 'Could not tell which provider this key belongs to. Choose the provider and try again.',
  'error.providerMismatch': 'The saved key belongs to a different provider. Save a key for this provider instead.',
  'error.modelUnknown': 'The provider does not offer that model. Pick one from the list.',
  'error.keyRequired': 'No AI key is saved, and this server’s shared AI is not available for your account. Add your own key.',
  'error.encryptionMissing': 'This server cannot store keys yet (its encryption key is not set up). Ask the admin, then try again.',
  'error.keyUnreadable': 'The saved key cannot be read here. Save it again.',
  'error.sharedKeyMissing': 'The shared AI is turned on, but this server has no shared key configured. Ask the admin.',
  'error.sharedModelMissing': 'The shared AI is turned on and has a key, but no model is chosen. Ask the admin.',
  'error.rateLimited': 'The AI provider is rate limiting requests. Wait a moment and try again.',
  'error.providerUnavailable': 'The AI provider is unavailable right now. Try again later.',
  'error.unreachable': 'Could not reach the server. Check your connection and try again.',
  'error.generic': 'Could not complete the request. Try again.',
} as const;
