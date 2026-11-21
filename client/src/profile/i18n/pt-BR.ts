import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'name.empty': 'O nome não pode ficar vazio',
  'name.tooLong': 'O nome deve ter no máximo {max} caracteres',
  'upload.tooLarge': 'Essa foto é grande demais (máx. 5 MB). Tente uma menor.',
  'upload.badType': 'Use uma foto JPEG, PNG ou WebP.',
  'upload.unreadable': 'Não foi possível ler essa imagem. Tente outra.',
  'upload.offline': 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
  'upload.failed': 'Falha no envio. Tente novamente.',
};
export default m;
