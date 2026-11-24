import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('aiKeys', en, { 'pt-BR': ptBR }, {
  // Provider names are brand names: the same in every language.
  sameAsEnglish: [
    'provider.openrouter',
    'provider.anthropic',
    'provider.openai',
    'provider.zai',
    'provider.deepseek',
  ],
});
