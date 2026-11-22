import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  // Row menu actions
  'menu.sync': 'Sincronizar agora',
  'menu.reimport': 'Reimportar histórico',
  'menu.reconnect': 'Reconectar credenciais',
  'menu.settings': 'Configurações',

  // Remove confirmation
  'remove.blockedTitle': 'Não é possível remover {institution}',
  'remove.blockedBody': {
    one: 'Desvincule antes a {count} conta vinculada no editor de contas.',
    other: 'Desvincule antes as {count} contas vinculadas no editor de contas.',
  },
  'remove.confirmTitle': 'Remover {institution}?',
  'remove.confirmBody': 'A conexão bancária será excluída. O histórico importado continua no seu orçamento.',

  // Actions (sync / re-import / remove)
  'actions.syncFailed': 'Não foi possível sincronizar o banco',
  'actions.reimportFailed': 'Não foi possível reimportar o histórico do banco',
  'actions.removeFailed': 'Não foi possível remover o banco',
  'actions.removed': 'Banco removido — o histórico importado continua no seu orçamento.',

  // Connect flow
  'flow.titleNew': 'Vincular conta bancária',
  'flow.titleReconnect': 'Reconectar banco',
  'flow.finishing': 'Concluindo a conexão…',
  'flow.opening': 'Abrindo a janela de conexão…',
  'flow.needsLogin': 'O banco precisa de uma janela de login própria — permita que ela abra e tente de novo.',
  'flow.startFailed': 'Não foi possível iniciar a conexão',
  'flow.refreshFailed': 'Não foi possível atualizar o banco reconectado',
  'flow.registerFailed': 'Não foi possível registrar o banco conectado',

  // Banks list and rows
  'list.none': 'Nenhum banco conectado ainda. Conecte um para trazer contas e transações.',
  'list.connectFirst': 'Conectar um banco',
  'list.connectAnother': 'Conectar outro banco',
  'list.summary': { one: '{count} banco · conectados: {connected}', other: '{count} bancos · conectados: {connected}' },
  'row.reauthAdded': 'Reconecte para atualizar as credenciais · adicionado {stamp}',
  'row.reauthSandbox': 'Reconecte para atualizar as credenciais · sandbox',
  'row.lastSync': 'Última sincronização: {stamp}',
  'row.lastSyncSandbox': 'Última sincronização: {stamp} · sandbox',
  'row.lastAdded': 'Última sincronização: adicionado {stamp}',
  'row.lastAddedSandbox': 'Última sincronização: adicionado {stamp} · sandbox',
  'row.openA11y': 'Abrir {name}',
  'row.syncA11y': 'Sincronizar {institution}',
  'row.editA11y': 'Editar {institution}',

  // Upstream accounts list
  'upstream.unavailable': 'Contas indisponíveis — use Sincronizar agora para atualizar.',
  'upstream.none': 'Este banco não retornou nenhuma conta.',
  'upstream.type.credit': 'cartão',
  'upstream.type.bank': 'banco',
  'upstream.notLinked': 'sem vínculo',

  // Sync window control
  'window.default': 'Padrão ({label})',
  'window.defaultA11y': 'Histórico de sincronização padrão',
  'window.presetA11y': 'Histórico de sincronização {label}',
  'window.daysPlaceholder': 'dias',
  'window.set': 'Definir',
  'window.setA11y': 'Aplicar período de sincronização personalizado',
  'window.cancelA11y': 'Cancelar período de sincronização personalizado',
  'window.customDays': '{days}d',
  'window.other': 'Outro…',
  'window.customA11y': 'Período de sincronização personalizado',
};

export default m;
