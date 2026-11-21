import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'screen.title': 'Relatórios',
  'caption.accounts': 'Patrimônio líquido e gastos de {accounts}',
  'report.breakdown': 'Detalhamento de gastos',
  'report.trends': 'Tendência de gastos',
  'report.networth': 'Patrimônio líquido',
  'range.all': 'Todo o período',
  'range.last': 'Últimos {count} meses',
  'networth.assets': 'Ativos {amount}',
  'networth.debts': 'Dívidas {amount}',
  'networth.change': 'Variação {percent}',
  'trends.total': 'Gasto total',
  'breakdown.bundleLabel': 'Conjunto {name}',
  'breakdown.empty': 'Nenhum gasto categorizado neste período.',
};

export default m;
