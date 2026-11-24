import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'screen.title': 'Chave de IA',
  'screen.intro':
    'As sugestões de categoria podem usar um provedor de IA. Sua chave é enviada ao nosso servidor e guardada lá criptografada; ela nunca é mostrada de novo e não é salva neste aparelho.',
  'screen.loadFailed': 'Não foi possível carregar sua chave de IA.',

  'state.ownTitle': 'SUA CHAVE DE IA',
  'state.provider': 'Provedor',
  'state.model': 'Modelo',
  'state.none': 'Não escolhido',
  'state.noModel': 'Nenhum modelo escolhido ainda. Troque a chave para escolher um.',
  'state.unreadable':
    'Esta chave salva não pode mais ser aberta neste servidor (a chave de criptografia pode ter mudado). Salve a chave de novo.',
  'state.blockedTitle': 'CHAVE SALVA',
  'state.blocked':
    'Uma chave salva na sua conta não pode mais ser usada (este servidor não reconhece o provedor dela, ou não consegue abri-la). Enquanto ela estiver guardada, as sugestões de categoria não usam a IA compartilhada. Salve uma nova chave ou remova-a.',
  'state.saveNewKey': 'Salvar uma nova chave',
  'state.savedAt': 'Salva em {date}',
  'state.test': 'Testar chave',
  'state.testing': 'Testando…',
  'state.replace': 'Trocar chave',
  'state.remove': 'Remover chave',
  'state.removeConfirm':
    'Remover sua chave de IA? As sugestões de categoria param até você salvar outra, ou até a IA compartilhada deste servidor estar disponível para sua conta.',
  'state.removing': 'Removendo…',
  'state.testOk': {
    one: 'Chave aceita: {count} modelo disponível em {provider}.',
    other: 'Chave aceita: {count} modelos disponíveis em {provider}.',
  },

  'shared.title': 'IA COMPARTILHADA DO SERVIDOR',
  'shared.body':
    'Este servidor oferece uma chave de IA compartilhada: {provider}, modelo {model}. Adicione sua própria chave abaixo para usá-la no lugar — a sua tem prioridade.',
  'shared.bodyNoModel':
    'Este servidor oferece uma chave de IA compartilhada. Adicione sua própria chave abaixo para usá-la no lugar — a sua tem prioridade.',

  'form.addTitle': 'ADICIONAR SUA CHAVE DE IA',
  'form.replaceTitle': 'TROCAR SUA CHAVE DE IA',
  'form.keyLabel': 'Chave de API',
  'form.keyPlaceholder': 'Cole sua chave de API',
  'form.keyHint': 'Guardada criptografada no nosso servidor e nunca mostrada de novo. Não é salva neste aparelho.',
  'form.detecting': 'Detectando provedor…',
  'form.providerLabel': 'Provedor',
  'form.providerUnknown': 'Não deu para saber a qual provedor esta chave pertence. Escolha um abaixo.',
  'form.providerRequired': 'Escolha um provedor antes de salvar.',
  'form.detected': 'Detectado pela chave: {provider}. Você pode mudar.',
  'form.providerDiffers': 'A chave parece ser de {detected}, mas {chosen} está selecionado.',
  'form.providerChosen': 'Escolha o provedor dono desta chave.',
  'form.modelLabel': 'Modelo',
  'form.modelPlaceholder': 'Buscar modelos',
  'form.modelsLoading': 'Carregando modelos…',
  'form.modelsEmpty': 'Este provedor não retornou modelos.',
  'form.manualModelHint':
    'Não foi possível carregar a lista de modelos. Digite o id de um modelo, se souber, ou salve a chave sem modelo.',
  'form.zaiTypedHint': 'A lista é uma sugestão; você também pode digitar qualquer id de modelo.',
  'form.useTypedModel': 'Usar "{model}"',
  'form.saveWithoutModel': 'Nenhum modelo escolhido — você pode salvar a chave sem um.',
  'form.keyTooShort': 'A chave parece curta demais. Cole a chave inteira.',
  'form.save': 'Salvar chave',
  'form.saving': 'Verificando e salvando…',

  'notice.saved': 'Chave salva e verificada com {provider}.',
  'notice.removed': 'Chave removida.',

  'provider.openrouter': 'OpenRouter',
  'provider.anthropic': 'Anthropic',
  'provider.openai': 'OpenAI',
  'provider.zai': 'Z.ai',
  'provider.deepseek': 'DeepSeek',

  'error.keyRejected': 'O provedor de IA não aceitou esta chave. Confira e tente de novo.',
  'error.providerUnknown': 'Não deu para saber a qual provedor esta chave pertence. Escolha o provedor e tente de novo.',
  'error.providerMismatch': 'A chave salva é de outro provedor. Salve uma chave para este provedor.',
  'error.modelUnknown': 'O provedor não oferece esse modelo. Escolha um da lista.',
  'error.keyRequired': 'Nenhuma chave de IA está salva, e a IA compartilhada deste servidor não está disponível para sua conta. Adicione sua própria chave.',
  'error.encryptionMissing': 'Este servidor ainda não consegue guardar chaves (a chave de criptografia não está configurada). Peça ao admin e tente de novo.',
  'error.keyUnreadable': 'A chave salva não pode ser lida aqui. Salve de novo.',
  'error.sharedKeyMissing': 'A IA compartilhada está ligada, mas este servidor não tem chave compartilhada configurada. Peça ao admin.',
  'error.sharedModelMissing': 'A IA compartilhada está ligada e tem chave, mas nenhum modelo foi escolhido. Peça ao admin.',
  'error.rateLimited': 'O provedor de IA está limitando requisições. Espere um momento e tente de novo.',
  'error.providerUnavailable': 'O provedor de IA está indisponível agora. Tente mais tarde.',
  'error.generic': 'Não foi possível completar a requisição. Tente de novo.',
};

export default m;
