import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  // Shared actions
  'action.import': 'Importar arquivo',
  'action.reconcile': 'Conciliar',
  'action.editAccount': 'Editar conta',
  'action.showReconciled': 'Mostrar conciliadas',
  'action.hideReconciled': 'Ocultar conciliadas',
  'menu.moreActions': 'Mais ações',

  // Account types (header subtitle and add-account chips)
  'accountType.checking': 'Conta corrente',
  'accountType.savings': 'Poupança',
  'accountType.cash': 'Dinheiro',
  'accountType.creditCard': 'Cartão de crédito',
  'accountType.tracking': 'Conta de acompanhamento',

  // Header
  'header.allAccounts': 'Todas as contas',
  'header.editAccount': 'Editar conta {name}',
  'header.lastReconciled': 'Última conciliação em {date}',
  'header.notReconciled': '🔒 Ainda não conciliada',
  'header.futureInstallments': 'Parcelas futuras: {amount}',
  'header.toApprove': '{count} para aprovar',
  'header.toApproveLabel': {
    one: '{count} transação para aprovar',
    other: '{count} transações para aprovar',
  },

  // More menu
  'moreMenu.hint': 'Importar arquivo, Conciliar, Mostrar conciliadas, Editar conta',
  'moreMenu.closeLabel': 'Fechar menu de ações',

  // Edit account modal
  'edit.closedBanner': 'Esta conta está encerrada — os detalhes são somente leitura. Reabra-a para fazer alterações.',
  'edit.sectionInfo': 'INFORMAÇÕES DA CONTA',
  'edit.nickname': 'Apelido da conta',
  'edit.nicknamePlaceholder': 'Apelido da conta',
  'edit.notes': 'Notas da conta',
  'edit.notesPlaceholder': 'Notas',
  'edit.person': 'Pessoa',
  'edit.workingBalance': 'Saldo atual',
  'edit.balanceHint': 'Define o saldo diretamente — é um ajuste manual, não um lançamento.',
  'edit.sectionBank': 'CONEXÃO BANCÁRIA',
  'edit.reopen': 'Reabrir',
  'edit.deleting': 'Excluindo…',
  'edit.closeAccount': 'Encerrar conta',

  // Add account modal
  'add.title': 'Adicionar conta',
  'add.nameLabel': 'Nome da conta',
  'add.namePlaceholder': 'ex.: Conta corrente',
  'add.typeLabel': 'Tipo de conta',
  'add.person': 'Pessoa',
  'add.openingBalance': 'Saldo inicial',
  'add.create': 'Criar conta',
  'add.nameRequired': 'o nome da conta é obrigatório',
  'add.createFailed': 'falha ao criar a conta',
  'add.group.cash': 'DINHEIRO',
  'add.group.credit': 'CRÉDITO',
  'add.group.debt': 'DÍVIDAS E EMPRÉSTIMOS',
  'add.type.lineOfCredit': 'Limite de crédito',
  'add.type.otherLiability': 'Outro passivo',
  'add.type.mortgage': 'Financiamento imobiliário',
  'add.type.autoLoan': 'Financiamento de veículo',
  'add.type.studentLoan': 'Crédito estudantil',
  'add.type.personalLoan': 'Empréstimo pessoal',
  'add.type.medicalDebt': 'Dívida médica',
  'add.type.otherDebt': 'Outra dívida',

  // Add transaction sheet
  'sheet.toggleKind': 'Alternar entre gasto e receita',
  'sheet.income': '⊞ Receita ⇅',
  'sheet.spending': '⊟ Gasto ⇅',

  // Approval banner
  'banner.info': 'Informação',
  'banner.text': {
    one: '{count} nova transação para aprovar ou categorizar.',
    other: '{count} novas transações para aprovar ou categorizar.',
  },
  'banner.showAllLabel': 'Mostrar todas as transações',
  'banner.viewUnapprovedLabel': 'Ver transações não aprovadas',
  'banner.viewAll': 'Ver todas',
  'banner.view': 'Ver',
  'banner.dismiss': 'Dispensar aviso de aprovação',

  // Toolbar
  'toolbar.comfortable': 'Linhas confortáveis',
  'toolbar.compact': 'Linhas compactas',
  'toolbar.syncStatus': 'Status da sincronização bancária: {bank} {label}',
  'toolbar.searchPlaceholder': 'Pesquisar em todas as contas',
  'toolbar.searchLabel': 'Pesquisar transações',
  'toolbar.addTransaction': 'Adicionar transação',
  'toolbar.undo': 'Desfazer',
  'toolbar.redo': 'Refazer',
  'toolbar.view': 'Exibir',
  'toolbar.viewOptions': 'Opções de exibição',
  'toolbar.closeViewMenu': 'Fechar menu de exibição',
  'toolbar.runningBalance': 'Saldo acumulado',
  'toolbar.showClosedTxns': 'Mostrar transações de contas encerradas',
  'toolbar.dateHint': 'AAAA-MM-DD',
  'toolbar.from': 'De',
  'toolbar.to': 'Até',
  'toolbar.fromLabel': 'Filtrar a partir da data',
  'toolbar.toLabel': 'Filtrar até a data',

  // Reconcile banner and popover
  'reconcile.bankBalance': 'Saldo do banco',
  'reconcile.balanced': '✓ saldo confere',
  'reconcile.difference': 'Diferença: {amount}',
  'reconcile.finish': 'Concluir conciliação',
  'reconcile.anyway': 'Conciliar mesmo assim',
  'reconcile.closeQuestion': 'Fechar pergunta de conciliação',
  'reconcile.question': 'Seu saldo atual é {amount}?',
  'reconcile.no': 'Não',
  'reconcile.yes': 'Sim',
  'reconcile.done': 'Conta conciliada',
  'reconcile.failed': 'falha ao conciliar a conta',
  'reconcile.linkedToast': {
    one: '{count} conta vinculada',
    other: '{count} contas vinculadas',
  },

  // Register rows and header
  'register.selectAll': 'Selecionar todas as transações',
  'register.colAccount': 'CONTA',
  'register.colDate': 'DATA',
  'register.colPayee': 'FAVORECIDO',
  'register.colCategory': 'CATEGORIA',
  'register.colMemo': 'OBSERVAÇÃO',
  'register.colAmount': 'VALOR',
  'register.colRunningBalance': 'SALDO ACUM.',
  'register.colCleared': 'C',
  'register.noPayee': '(sem favorecido)',
  'register.editLabel': 'Editar transação {payee}',
  'register.selectLabel': 'Selecionar transação {payee}',
  'register.repeat': 'Repetir',

  // Scheduled section
  'scheduled.title': 'Transações agendadas',
  'scheduled.rowLabel': 'Transação agendada {name}',
  'scheduled.selectLabel': 'Selecionar transação agendada {name}',
  'scheduled.installmentLabel': 'Parcela futura do cartão {name}, ainda não faturada',

  // Selection bar
  'selection.closeMenu': 'Fechar menu',
  'selection.readyToAssign': 'Pronto para atribuir',
  'selection.noFlag': 'Sem marcador',
  'selection.moveToAccount': 'Mover para a conta',
  'selection.noOtherAccounts': 'Nenhuma outra conta',
  'selection.markUncleared': 'Marcar como pendente',
  'selection.markCleared': 'Marcar como compensada',
  'selection.match': 'Associar',
  'selection.unmatch': 'Desassociar',
  'selection.duplicate': 'Duplicar',
  'selection.memo': 'Observação…',
  'selection.export': {
    one: 'Exportar {count} transação',
    other: 'Exportar {count} transações',
  },
  'selection.count': {
    one: '{count} transação',
    other: '{count} transações',
  },
  'selection.clear': 'Limpar seleção',
  'selection.categorize': 'Categorizar',
  'selection.categorizeLabel': 'Categorizar as transações selecionadas',
  'selection.flag': 'Marcador',
  'selection.flagLabel': 'Definir marcador das transações selecionadas',
  'selection.more': 'Mais',
  'selection.memoPrompt': 'Observação',
  'selection.deleteConfirm': {
    one: 'Excluir {count} transação?',
    other: 'Excluir {count} transações?',
  },
};
export default m;
