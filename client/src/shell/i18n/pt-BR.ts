import type { Translation } from '@shared/i18n';

import type en from './en';

const m: Translation<typeof en> = {
  'layout.menu': 'Menu',
  'layout.allBudgets': 'Todos os orçamentos',
  'layout.newTransaction': 'Nova transação',
  'layout.fabPill': '＋ Transação',
  'layout.unhideAmounts': 'Mostrar valores',
  'layout.amountsHidden': '🔒 Os valores estão ocultos — toque para mostrar',
  'menu.open': 'Abrir menu de configurações',
  'menu.close': 'Fechar menu',
  'rail.plan': 'Plano',
  'rail.reflect': 'Relatórios',
  'rail.allAccounts': 'Todas as contas',
  'rail.categorize': 'Categorizar',
  'rail.expand': 'Expandir barra lateral',
  'rail.collapse': 'Recolher barra lateral',
  'rail.openAccount': 'Abrir conta {name}',
  'rail.addAccount': 'Adicionar conta',
  'rail.addAccountButton': '＋ Adicionar conta',
  'rail.section.checking': 'Conta corrente',
  'rail.section.savings': 'Poupança',
  'rail.section.cash': 'Dinheiro',
  'rail.section.creditCards': 'Cartões de crédito',
  'rail.section.closed': 'Encerradas',
  'tabs.overview': 'Visão geral',
  'tabs.plan': 'Plano',
  'tabs.spending': 'Gastos',
  'tabs.accounts': 'Contas',
  'tabs.reflect': 'Relatórios',
};
export default m;
