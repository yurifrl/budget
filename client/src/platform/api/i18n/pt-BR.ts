import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'network.failed': 'Não foi possível acessar o servidor. Verifique sua conexão e tente novamente.',
};
export default m;
