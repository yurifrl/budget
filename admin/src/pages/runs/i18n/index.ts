import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('adminRuns', en, { 'pt-BR': ptBR }, { sameAsEnglish: ['col.status', 'col.worker', 'detail.workflow', 'detail.logs'] });
