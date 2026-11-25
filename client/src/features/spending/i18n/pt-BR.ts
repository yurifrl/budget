import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'screen.title': 'Gastos',
  'caption.accounts': 'Gastos em {accounts}',
  'review.title': 'Novas transações',
  'review.action': 'Revise abaixo',
  'empty.accounts': 'Nenhuma transação em {accounts}.',
  'empty.none': 'Nenhuma transação ainda.',
  'row.unknown': '🙋 O que é isto?',
  'row.noPayee': '(sem favorecido)',
  'row.approve': 'Aprovar',
};

export default m;
