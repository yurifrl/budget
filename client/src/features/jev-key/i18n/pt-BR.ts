export default {
  // JevKeyScreen
  'screen.title': 'Chave da API do Jev',
  'screen.help':
    'O Jev é o modelo de decisão que sugere uma categoria para cada transação. Ele roda no OpenRouter, então precisa de uma chave do OpenRouter. A chave é guardada criptografada no servidor e nunca aparece de novo.',

  // Card: o campo (nenhuma chave salva ainda, ou trocando a chave)
  'card.field': 'Chave da API do Jev',
  'card.save': 'Salvar chave',
  'card.checking': 'Conferindo com o Jev…',

  // Card: uma chave do servidor está em uso
  'card.serverKey': 'Chave do servidor em uso',
  'card.serverKeyBody':
    'Este servidor tem uma chave do Jev e a sua conta pode usá-la. Salve a sua própria chave para usar a sua no lugar dela.',

  // Card: o estado salvo
  'card.savedSection': 'CHAVE SALVA',
  'card.ending': 'termina em ••••{last4}',
  'card.savedAt': 'salva em {date}',
  'card.test': 'Testar chave',
  'card.testing': 'Testando…',
  'card.tested': 'O Jev aceitou esta chave.',
  'card.replace': 'Trocar chave',
  'card.removeConfirm': 'Remover a chave do Jev salva? As execuções do Categorizar param até você salvar uma chave de novo.',

  // Errors
  'error.required': 'Digite uma chave do Jev.',
  'error.rejected': 'O Jev recusou esta chave. Confira no OpenRouter e salve de novo.',
  'error.unavailable': 'O Jev não está disponível agora. Tente mais tarde.',
  'error.noCredits': 'A conta do OpenRouter desta chave está sem créditos. Adicione créditos ou use outra chave.',
  'error.unreadable': 'Sua chave salva não pode ser lida neste servidor. Salve de novo.',
  'error.removeFailed': 'Não foi possível remover a chave.',
  'error.noEncryption': 'Este servidor não consegue guardar chaves agora. Fale com quem o administra.',
  'error.codeMissing': 'Salve uma chave do Jev primeiro.',
  'error.saveFailed': 'Não foi possível salvar a chave.',
  'error.testFailed': 'Não foi possível testar a chave.',
  'error.loadFailed': 'Não foi possível ler sua chave do Jev.',

  // useJevKey
  'hook.saved': 'Chave salva. O Jev aceitou.',
  'hook.removed': 'Chave removida. As execuções do Categorizar precisam de uma chave de novo.',
} as const;
