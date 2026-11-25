import type { Translation } from '@shared/i18n';

import type en from './en';

const m: Translation<typeof en> = {
  'screen.title': 'Categorizar',

  'queue.subtitle': {
    one: '{count} transação sem categoria · sugestões prontas para {ready}',
    other: '{count} transações sem categoria · sugestões prontas para {ready}',
  },

  'bundle.dateRange': '{first} – {last}',

  'manual.belowThreshold': 'abaixo do limite',
  'manual.noSuggestion': 'sem sugestão',
  'manual.failed': 'a classificação falhou',
  'manual.notClassified': 'não classificada',

  'merchant.name': 'Estabelecimento',
  'merchant.legalName': 'Razão social',
  'merchant.cnpj': 'CNPJ',
  'merchant.businessCategory': 'Categoria do banco',
  'merchant.operationType': 'Tipo de operação',
  'merchant.counterparty': 'Contraparte do PIX',

  'toast.filed': '{subject} → {category}',
  'toast.filedCount': { one: '{count} transação categorizada', other: '{count} transações categorizadas' },
};
export default m;
