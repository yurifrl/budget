import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  // ConnectBankScreen: the Linked banks list
  'list.title': 'Bancos vinculados',
  'list.keysButton': 'Suas chaves do Pluggy',
  'list.working': 'Processando…',
  'list.checking': 'Verificando…',
  'list.bankRemoved': 'Banco removido — o histórico importado continua no seu orçamento.',

  // ConnectionSettingsScreen: the bank's page
  'page.title': 'Banco',
  'page.unlinked': 'Este banco não está mais vinculado.',
  'page.backLabel': 'Voltar para bancos vinculados',
  'page.backText': '‹ Bancos vinculados',
  'page.lastSync': 'Última sincronização: {stamp}',
  'page.lastSyncSandbox': 'Última sincronização: {stamp} · sandbox',
  'page.added': 'Última sincronização: adicionado em {stamp}',
  'page.historyLoading': 'Importando o histórico mais antigo — continua nas próximas sincronizações.',
  'page.addedSandbox': 'Última sincronização: adicionado em {stamp} · sandbox',
  'page.syncNow': 'Sincronizar agora',
  'page.syncing': 'Sincronizando…',
  'page.settings': 'Configurações',
  'page.settingsTitle': 'Configurações de {name}',
  'page.overview': 'Visão geral',
  'page.loadFailed': 'Não foi possível carregar este banco.',
  'page.upstreamFailed': 'Não foi possível carregar as contas do provedor.',
  'page.windowFailed': 'Não foi possível salvar o período de sincronização.',

  // LinkedAccountDetailScreen
  'detail.noAccount': 'Nenhuma conta selecionada.',
  'detail.notFound': 'Conta não encontrada neste orçamento.',
  'detail.readOnly': 'Somente leitura',
  'detail.empty': 'Nenhuma transação ainda — sincronize esta conexão para trazer os lançamentos do banco.',
  'detail.noPayee': '(sem favorecido)',
  'detail.repeat': 'Repetir',
  'detail.header.account': 'CONTA',
  'detail.header.date': 'DATA',
  'detail.header.payee': 'FAVORECIDO',
  'detail.header.category': 'CATEGORIA',
  'detail.header.memo': 'OBSERVAÇÃO',
  'detail.header.amount': 'VALOR',
  'detail.header.balance': 'SALDO ACUM.',
  'detail.header.cleared': 'C',
  'accountType.checking': 'Conta corrente',
  'accountType.savings': 'Poupança',
  'accountType.cash': 'Dinheiro',
  'accountType.credit': 'Cartão de crédito',
  'accountType.tracking': 'Conta de acompanhamento',

  // LinkedBy
  'linkedBy.prefix': 'Conexão feita por',
  'linkedBy.label': 'Conexão feita por {name}',

  // PluggyKeysScreen
  'keys.title': 'Suas chaves do Pluggy',
  'keys.connectBanner':
    'Para conectar um banco, adicione primeiro suas próprias chaves do Pluggy: as chaves compartilhadas do app não estão disponíveis para a sua conta.',
  'keys.connectButton': 'Conectar um banco',

  // model/bankPage.ts
  'txnState.edited': 'Editada por você',
  'txnState.removed': 'Removida no banco',
  'txnState.imported': 'Importada',

  // model/connections.ts and model/syncRun.ts: connection / sync status pills
  'status.synced': 'Em dia',
  'status.syncing': 'Sincronizando…',
  'status.queued': 'Na fila',
  'status.queuedOffline': 'Na fila · agendador offline',
  'status.reconnect': 'Reconectar',
  'status.actionNeeded': 'Requer ação',
  'status.limitReached': 'Limite do banco atingido',
  'status.paused': 'Em pausa · precisa das suas chaves',
  'status.error': 'Erro de sincronização',
  'status.disconnected': 'Sem conexão',
  'syncWindow.all': 'Todo o histórico',
  'syncWindow.year': '1 ano',
  'syncWindow.days': '{days}d',
  'error.providerUnreadable':
    'Não foi possível sincronizar com o banco — o provedor retornou dados que não conseguimos ler. Tentaremos de novo na próxima sincronização.',
  'credit.billDue': 'Fatura {bill} · vence {due}',
  'credit.bill': 'Fatura {bill}',
  'credit.due': 'vence {due}',
  'credit.limitUsed': 'limite usado {used} / {limit}',
  'credit.limit': 'limite {limit}',

  // model/syncRun.ts: one whole sentence per label ("Sync" / "Re-import")
  'syncRun.schedulerBanner':
    'A sincronização em segundo plano está offline. As sincronizações ficam na fila e serão executadas quando ela voltar — nada se perde.',
  'syncRun.sync.offline':
    'A sincronização em segundo plano está offline — a sincronização foi colocada na fila e será executada quando o agendador voltar.',
  'syncRun.sync.timeout': 'A sincronização ainda está em andamento em segundo plano.',
  'syncRun.sync.finished': 'Sincronização concluída.',
  'syncRun.sync.failed': 'A sincronização falhou. Tente novamente mais tarde.',
  'syncRun.sync.cancelled': 'A sincronização foi cancelada.',
  'syncRun.sync.completeNothing': 'Sincronização concluída — nada de novo',
  'syncRun.sync.completeCounts':
    'Sincronização concluída — {added} adicionadas · {updated} atualizadas · {deleted} removidas',
  'syncRun.reimport.offline':
    'A sincronização em segundo plano está offline — a reimportação foi colocada na fila e será executada quando o agendador voltar.',
  'syncRun.reimport.timeout': 'A reimportação ainda está em andamento em segundo plano.',
  'syncRun.reimport.finished': 'Reimportação concluída.',
  'syncRun.reimport.failed': 'A reimportação falhou. Tente novamente mais tarde.',
  'syncRun.reimport.cancelled': 'A reimportação foi cancelada.',
  'syncRun.reimport.completeNothing': 'Reimportação concluída — nada de novo',
  'syncRun.reimport.completeCounts':
    'Reimportação concluída — {added} adicionadas · {updated} atualizadas · {deleted} removidas',
  // model/syncRun.ts syncSkipLines: what the last finished sync left out
  'syncRun.skippedOtherAccount': {
    one: '{count} ignorada: já importada em “{account}”',
    other: '{count} ignoradas: já importadas em “{account}”',
  },
  'syncRun.skippedDeleted': {
    one: '{count} ignorada: foi excluída antes e continua excluída',
    other: '{count} ignoradas: foram excluídas antes e continuam excluídas',
  },
  'syncRun.skippedPaidInstallment': {
    one: '{count} ignorada: parcela pendente do cartão que já foi paga',
    other: '{count} ignoradas: parcelas pendentes do cartão que já foram pagas',
  },
  'syncRun.failedRows': {
    one: '{count} transação do banco não pôde ser importada',
    other: '{count} transações do banco não puderam ser importadas',
  },

  // model/linkPicker.ts
  'picker.creditToCash': 'Este é um cartão de crédito, mas a conta do orçamento é uma conta de dinheiro',
  'picker.bankToCredit': 'Esta é uma conta bancária, mas a conta do orçamento é um cartão de crédito',
  'picker.bankAccount': 'Conta bancária',
  'picker.anotherAccount': 'outra conta',
  'picker.aBankAccount': 'uma conta bancária',
  'picker.budgetAccounts': 'Contas do orçamento',
  'picker.unavailable': 'Não foi possível carregar as contas de {label} — sincronize ou reconecte',
  'linkType.checking': 'Conta corrente',
  'linkType.savings': 'Poupança',
  'linkType.cash': 'Dinheiro',
  'linkType.creditCard': 'Cartão de crédito',
  'linkType.lineOfCredit': 'Limite de crédito',
  'linkType.otherAsset': 'Outro ativo',
  'linkType.otherLiability': 'Outro passivo',
  'linkType.mortgage': 'Financiamento imobiliário',
  'linkType.autoLoan': 'Financiamento de veículo',
  'linkType.studentLoan': 'Crédito estudantil',
  'linkType.personalLoan': 'Empréstimo pessoal',
  'linkType.medicalDebt': 'Dívida médica',
  'linkType.account': 'Conta',
};
export default m;
