import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'keypad.save': 'Salvar transação',
  'keypad.key': 'Tecla {key}',

  'field.payee': 'Favorecido',
  'field.category': 'Categoria',
  'field.account': 'Conta',
  'field.date': 'Data',
  'field.choose': 'Escolher…',
  'field.readyToAssign': 'Pronto para atribuir',

  'picker.payeeSearch': 'Buscar ou adicionar um favorecido',
  'picker.categorySearch': 'Buscar categorias',
  'picker.categorySearchLabel': 'Buscar categorias',
  'picker.sectionTransfers': 'Pagamentos e transferências',
  'picker.sectionPayees': 'Favorecidos salvos',
  'picker.offBudget': 'Fora do orçamento',
  'field.categoryNotNeeded': 'Categoria não necessária',
  'picker.createPayee': 'Criar favorecido “{query}”',
  'picker.createCategory': 'Criar categoria “{query}”',

  'error.createCategory': 'Não foi possível criar a categoria',
  'error.save': 'Não foi possível salvar a transação',
};
export default m;
