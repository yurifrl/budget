import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('settings', en, { 'pt-BR': ptBR }, {
  sameAsEnglish: ['language.option.en', 'language.option.ptBR'],
});
