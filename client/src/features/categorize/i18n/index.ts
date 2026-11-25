import { defineMessages } from '@shared/i18n';

import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('categorize', en, { 'pt-BR': ptBR }, {
  // Format-only messages and the CNPJ acronym: identical by design.
  sameAsEnglish: ['bundle.dateRange', 'toast.filed', 'merchant.cnpj', 'header.thresholdValue', 'chip.label'],
});
