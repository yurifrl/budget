import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('banks.connect', en, { 'pt-BR': ptBR }, {
  sameAsEnglish: ['window.customDays'],
});
