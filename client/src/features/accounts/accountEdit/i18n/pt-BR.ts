import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'link.unavailable': 'Lista de contas do banco indisponível — use Sincronizar agora para atualizar.',
  'link.stale': 'Este vínculo não corresponde mais a uma conta do banco — altere o vínculo para escolher outra.',
  'link.connectedTo': 'Conexão com {institution}',
  'link.bankFallback': 'banco',

  'delete.title': 'Excluir conta',
  'delete.body':
    'Excluir <b>{accountName}</b> permanentemente, junto com todas as transações que ela já teve? O saldo da conta será removido do seu plano. Esta ação não pode ser desfeita.',
  'delete.deleting': 'Excluindo…',

  'close.title': 'Encerrar conta',
  'close.plain': 'Tem certeza de que deseja encerrar esta conta?',
  'close.confirm': 'Encerrar',
  'close.adjustBody':
    'Antes de encerrar esta conta, o saldo precisa ser zerado. Será criada uma transação de ajuste de <b>{amount}</b>.',
  'close.leavesPlan':
    'O dinheiro desta conta será removido do seu plano. Se quiser mantê-lo no seu plano, transfira-o para outra conta antes de encerrar esta.',
  'close.adjustConfirm': 'Ajustar saldo e encerrar',

  'connection.following': 'ACOMPANHANDO',
  'connection.syncNow': 'Sincronizar agora',
  'connection.syncing': 'Sincronizando…',
  'connection.reconnect': 'Reconectar',
  'connection.manage': 'Gerenciar na página do banco',
  'connection.changeLink': 'Alterar vínculo',
  'connection.unlink': 'Desvincular',
  'connection.notLinked': 'Sem vínculo com um banco. Conecte um para importar transações e atualizar o saldo automaticamente.',
  'connection.chooseAccount': 'Escolher conta bancária',
  'connection.connectNew': 'Conectar um novo banco',

  'error.sync': 'Não foi possível sincronizar a conexão bancária',
  'error.update': 'Não foi possível atualizar a conta',
  'error.close': 'Não foi possível encerrar a conta',
  'error.delete': 'Não foi possível excluir a conta',
};
export default m;
