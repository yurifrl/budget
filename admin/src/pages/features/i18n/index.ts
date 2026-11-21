import { defineMessages } from '@shared/i18n';
import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('adminFeatures', en, { 'pt-BR': ptBR }, { sameAsEnglish: ['userCol.email', 'userCol.status'], dynamicPrefixes: ['feature.', 'group.'] });
