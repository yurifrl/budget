import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  // Overview tab
  'overview.stat.linked': 'Contas vinculadas',
  'overview.stat.imported': 'Importadas',
  'overview.stat.edited': 'Editadas por você',
  'overview.stat.removed': 'Removidas no banco',
  'overview.stat.total': 'Total de linhas',
  'overview.accounts': 'Contas',
  'overview.notLinked': 'Sem vínculo',
  'overview.empty': 'Nenhuma conta do orçamento está vinculada a este banco ainda. Use “Vincular a uma conta do orçamento” em uma conta bancária abaixo.',
  'overview.unlinked.credit': 'Conta de cartão · sem vínculo com uma conta do orçamento',
  'overview.unlinked.bank': 'Conta bancária · sem vínculo com uma conta do orçamento',
  'overview.linkButton': 'Vincular a uma conta do orçamento',
  'overview.linkA11y': 'Vincular {name} a uma conta do orçamento',
  'overview.noTransactions': 'Nenhuma transação ainda',
  'overview.openA11y': 'Abrir {name}',
  'overview.account.credit': 'Conta de cartão → {name}',
  'overview.account.bank': 'Conta bancária → {name}',
  'overview.linkedTo': 'Vinculada a {name}',
  'overview.change': 'Alterar',
  'overview.changeA11y': 'Alterar vínculo de {name}',
  'overview.unlinkA11y': 'Desvincular {name}',

  // Link option card
  'card.currentBill': 'Fatura atual',
  'card.dueDate': 'Vencimento',
  'card.limitUsed': 'Limite usado',
  'card.limit': 'Limite',
  'card.linkedTo': 'Vinculada a {name}',
  'card.matches': 'Confere com o seu saldo',
  'card.different': '{amount} de diferença',

  // Link picker
  'picker.loadFailed': 'Não foi possível carregar suas contas bancárias — o banco não respondeu.',
  'picker.retryA11y': 'Tentar carregar as contas bancárias de novo',
  'picker.linking': 'Vinculando…',
  'picker.linkTo': 'Vincular a {title}',
  'picker.selectOne': 'Selecione uma para vincular',

  // Link sheets
  'sheet.linkTitle': 'Vincular {name}',
  'sheet.account.heading': 'Escolha uma conta do orçamento',
  'sheet.account.helper': 'Uma conta bancária alimenta exatamente uma conta do orçamento. Toque em uma conta para selecioná-la e depois confirme.',
  'sheet.account.owed': 'Devido no cartão',
  'sheet.account.bankBalance': 'Saldo no banco',
  'sheet.account.empty': 'Não há contas abertas do orçamento para vincular.',
  'sheet.bank.heading': 'Escolha uma conta bancária',
  'sheet.bank.helper': 'Uma conta do orçamento acompanha exatamente uma conta bancária. Toque em uma para selecioná-la e depois confirme.',
  'sheet.bank.reference': 'Seu saldo no Budget',
  'sheet.bank.empty': 'Ainda não há contas bancárias disponíveis — conecte primeiro um novo banco.',

  // Link / unlink actions
  'link.failed': 'Não foi possível vincular a conta',
  'link.unlinkFailed': 'Não foi possível desvincular a conta',
  'link.restoreFailed': '{failure} (e não foi possível restaurar o vínculo anterior: {restored})',

  // Unlink confirmation
  'unlink.title': 'Desvincular conta bancária?',
  'unlink.body': '{name} deixará de sincronizar com o banco. As transações já importadas continuam no seu orçamento; nenhuma nova chegará até você vincular de novo.',
  'unlink.busy': 'Desvinculando…',
  'unlink.button': 'Desvincular',

  // Bank balance card
  'balance.title': 'SALDO NO BANCO',
  'balance.matches': 'Confere com o orçamento',
  'balance.differs': 'Orçamento difere em {amount}',
  'balance.in': '↑ {amount} de entrada',
  'balance.out': '↓ {amount} de saída',
  'balance.last30': 'últimos 30 dias',

  // Credit bill card
  'bill.current': 'FATURA ATUAL',
  'bill.title': 'FATURA',
  'bill.due': 'Vence em {date}',
  'bill.usedPct': 'usado · {pct}%',
  'bill.used': 'usado',
  'bill.of': 'de {amount}',
  'bill.available': '{amount} disponível',
  'bill.limit': 'Limite {amount}',

  // Account tab
  'account.loadFailed': 'Não foi possível carregar as transações desta conta.',
  'account.empty': 'Ainda não há transações importadas para esta conta. Sincronize o banco para buscá-las.',
  'account.col.date': 'DATA',
  'account.col.payee': 'FAVORECIDO',
  'account.col.memo': 'OBSERVAÇÃO',
  'account.col.state': 'ESTADO',
  'account.col.amount': 'VALOR',
  'account.col.cleared': 'C',
  'account.noPayee': '(sem favorecido)',
  'account.loadMore': 'Carregar mais',
  'account.end': { one: '{count} transação · fim do histórico', other: '{count} transações · fim do histórico' },

  // Settings panel
  'settings.history.title': 'Histórico de sincronização',
  'settings.history.hint': 'Até onde as buscas deste banco voltam no tempo. O padrão segue a configuração geral do app.',
  'settings.reimport': 'Reimportar histórico',
  'settings.credentials.title': 'Credenciais',
  'settings.credentials.hint': 'O banco precisa de novas credenciais antes de poder sincronizar de novo.',
  'settings.reconnect': 'Reconectar',
  'settings.danger.title': 'Zona de perigo',
  'settings.danger.hint': 'Remove a conexão bancária. O histórico importado continua no seu orçamento.',
  'settings.remove': 'Remover banco',
  'settings.unlinkFirst': 'Desvincule antes as contas dele no editor de contas.',
};

export default m;
