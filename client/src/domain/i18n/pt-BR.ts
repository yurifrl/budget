import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'system.startingBalance': 'Saldo inicial',
  'system.reconciliationAdjustment': 'Ajuste de conciliação',
  'system.creditCardPayments': 'Pagamentos de cartão de crédito',
  'system.transfer': 'Transferência : {account}',

  'account.nicknameRequired': 'o apelido é obrigatório',

  'repeat.weekly': 'Toda semana',
  'repeat.everyOtherWeek': 'A cada duas semanas',
  'repeat.monthly': 'Mensal',
  'repeat.everyOtherMonth': 'A cada dois meses',
  'repeat.quarterly': 'Trimestral',
  'repeat.yearly': 'Anual',

  'split.totalOut': '{amount} de saída',
  'split.totalIn': '{amount} de entrada',
  'split.noAmount': 'sem valor',

  'inline.amountRequired': 'informe um valor',
  'inline.dateInvalid': 'data inválida — tente {format} ou 5, 5/9',
  'inline.splitCategoryRequired': 'toda divisão precisa de uma categoria',
  'inline.splitAmountRequired': 'informe um valor em cada divisão',
  'inline.rateFetching': 'buscando a cotação USD→BRL — tente de novo em instantes',
  'inline.rateMissing': 'nenhuma cotação disponível — informe o valor em R$ (sem $)',

  'overspend.underfundedLabel': 'Falta financiar {amount}',
  'overspend.underfundedDetail': 'Faltam {amount} para cobrir a dívida deste cartão',
  'overspend.creditLabel': '{amount} no crédito',
  'overspend.creditDetail': '{amount} gastos no crédito sem dinheiro atribuído: somados à dívida do cartão',

  'drop.addTo': 'Adicionar a {name}',
  'drop.bundleWith': 'Agrupar com {name}',

  'register.readyToAssign': 'Pronto para atribuir',
  'register.split': 'Divisão ({count})',
  'register.notNeeded': 'Categoria não necessária',
  'register.transferWaiting': 'Transferência · aguardando o outro lado',
  'register.needsCategory': 'precisa de categoria',

  'flag.red': 'Vermelho',
  'flag.orange': 'Laranja',
  'flag.yellow': 'Amarelo',
  'flag.green': 'Verde',
  'flag.blue': 'Azul',
  'flag.purple': 'Roxo',

  'target.perWeek': 'por semana',
  'target.perMonth': 'por mês',
  'target.byDate': 'até {date}',

  'people.shared': 'Compartilhado',
  'people.unnamed': 'Sem nome',
  'people.formerMember': 'Ex-membro',
  'people.sharedAccounts': 'Contas compartilhadas',
  'people.accountsOf': 'Contas de {name}',
  'people.sharedCategories': 'Categorias compartilhadas',
  'people.categoriesOf': 'Categorias de {name}',
  'invite.nameTooLong': 'O nome deve ter no máximo {max} caracteres',
  'invite.nameRequired': 'Informe um nome (ou um e-mail)',
  'invite.emailInvalid': 'Isso não parece um e-mail válido',
  'invite.alreadyMember': '{name} já está neste orçamento',
  'invite.emailRequired': 'Informe um e-mail',
};
export default m;
