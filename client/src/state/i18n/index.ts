import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('state', en, {
  'pt-BR': ptBR,
}, {
  sameAsEnglish: ['edit.ageNow', 'edit.ageHours', 'edit.ageDays'],
});
