import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('banks', en, { 'pt-BR': ptBR }, {
  // '{days}d' and the bare column letter are the same in both languages.
  sameAsEnglish: ['syncWindow.days', 'detail.header.cleared'],
});
