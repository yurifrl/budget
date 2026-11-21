import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'budget.loadFailed': 'falha ao carregar os dados do orçamento',

  'edit.readyToAssign': 'Pronto para atribuir',
  'edit.assign': 'Atribuir {delta} · {category}',
  'edit.move': 'Mover {amount} · {from} → {to}',
  'edit.autoAssign': {
    one: '{strategy} · {count} categoria',
    other: '{strategy} · {count} categorias',
  },
  'edit.ageNow': 'agora',
  'edit.ageMinutes': '{count}min',
  'edit.ageHours': '{count}h',
  'edit.ageDays': '{count}d',
};
export default m;
