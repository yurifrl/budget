import { defineMessages } from '@shared/i18n';

import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('auth', en, { 'pt-BR': ptBR }, { sameAsEnglish: ['form.email'] });
