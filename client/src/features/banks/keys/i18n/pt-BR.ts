import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  // pluggyKeys.logic.ts: form checks and save / remove errors
  'form.clientIdRequired': 'Informe o client ID da sua aplicação no Pluggy.',
  'form.clientSecretRequired': 'Informe o client secret da sua aplicação no Pluggy.',
  'form.invalidCredentials':
    'O Pluggy não aceitou este client ID e este client secret. Confira os dois (copie-os de novo da sua aplicação) e tente novamente.',
  'form.keyMissing':
    'Este servidor ainda não consegue guardar chaves (a chave de criptografia dele não está configurada). Fale com o administrador e tente novamente.',
  'form.inputFallback': 'Confira o client ID e o client secret.',
  'form.secretInvalid': 'O client secret está vazio ou é longo demais.',
  'form.clientIdInvalid': 'O client ID está vazio ou é longo demais.',
  'form.unreachable': 'Não foi possível acessar o servidor. Verifique sua conexão e tente novamente.',
  'form.saveFailed': 'Não foi possível salvar suas chaves. Tente novamente.',
  'form.removeFailed': 'Não foi possível remover suas chaves. Tente novamente.',

  // pluggyKeys.logic.ts: what a paused connection tells its owner
  'paused.ownWhy': 'Em pausa: as chaves do Pluggy com que este banco foi conectado não estão mais salvas.',
  'paused.ownTodo': 'Salve de novo o mesmo client ID e client secret em Suas chaves do Pluggy e a conexão volta sozinha.',
  'paused.ownAction': 'Suas chaves do Pluggy',
  'paused.sharedWhy':
    'Em pausa: este banco usa as chaves compartilhadas do Pluggy do app, que não estão disponíveis para a sua conta. Adicione suas próprias chaves do Pluggy e conecte o banco de novo.',
  'paused.sharedTodo':
    'Ou peça ao administrador para reativar as chaves compartilhadas para você: o banco volta sozinho.',
  'paused.sharedAction': 'Adicionar suas chaves do Pluggy',

  // PluggyKeysCard
  'card.loadFailed': 'Não foi possível carregar suas chaves.',
  'card.yourKeys': 'SUAS CHAVES',
  'card.clientId': 'Client ID',
  'card.clientSecret': 'Client secret',
  'card.secretSaved': 'Salvo (oculto)',
  'card.savedAt': 'Salvo em {stamp}',
  'card.removeConfirm':
    'Remover suas chaves? Os bancos conectados com elas deixam de sincronizar (ficam em pausa, não são excluídos) até você salvar as mesmas chaves de novo.',
  'card.removing': 'Removendo…',
  'card.removeKeys': 'Remover chaves',
  'card.replaceKeys': 'Substituir chaves',
  'card.replaceTitle': 'SUBSTITUIR SUAS CHAVES',
  'card.addTitle': 'ADICIONAR SUAS CHAVES',
  'card.clientIdPlaceholder': 'ex.: 3f2a…',
  'card.secretPlaceholderNew': 'Cole o novo client secret',
  'card.secretPlaceholder': 'Cole o client secret',
  'card.secretHint':
    'O Pluggy confere o par antes de salvar. O client secret é guardado criptografado e nunca é exibido de novo.',
  'card.checking': 'Verificando com o Pluggy…',
  'card.saveKeys': 'Salvar chaves',

  // PluggyKeysHelp
  'help.title': 'COMO OBTER SUAS CHAVES',
  'help.intro': 'O app acessa seu banco pelo Pluggy, usando chaves que pertencem a você. Leva poucos minutos:',
  'help.step1':
    'Cadastre-se gratuitamente em <link>dashboard.pluggy.ai</link>. Esse é o MeuPluggy, a opção gratuita do Pluggy para uso pessoal.',
  'help.step2': 'Crie uma aplicação no painel.',
  'help.step3':
    'Copie o client ID e o client secret e cole aqui. O Pluggy mostra o secret só uma vez, então cole logo (perdeu? crie um novo lá).',
  'help.step4': 'Depois conecte seu banco aqui: na janela de conexão, escolha MeuPluggy e entre nele.',
  'help.limit': 'O MeuPluggy permite até {limit} conexões bancárias.',

  // usePluggyKeys
  'hook.saved': 'Chaves salvas. O Pluggy as aceitou.',
  'hook.removed': 'Chaves removidas. Os bancos conectados com elas ficam em pausa até você salvar as mesmas chaves de novo.',
};
export default m;
