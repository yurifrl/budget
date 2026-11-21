import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('accounts.register', en, { 'pt-BR': ptBR }, {
  sameAsEnglish: ['conv.rate', 'menu.matchOption'],
});
