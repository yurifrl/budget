import { defineMessages } from '../index';
import en from './en';
import ptBR from './pt-BR';

/**
 * Words every screen shares (Cancel, Save, month and weekday names, the long
 * date pattern). Frozen: add your own words to your feature namespace.
 */
export const tCommon = defineMessages('common', en, { 'pt-BR': ptBR }, {
  sameAsEnglish: ['ok', 'month.short.1', 'month.short.3', 'month.short.6', 'month.short.7', 'month.short.11'],
  skipUnusedCheck: true,
});
