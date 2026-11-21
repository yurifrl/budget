import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('banks.keys', en, { 'pt-BR': ptBR }, {
  // "Client secret" is the field's name in the Pluggy dashboard: kept as is.
  sameAsEnglish: ['card.clientSecret'],
});
