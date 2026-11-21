import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'header.signOut': 'Sair',
  'header.newBudget': 'Novo orçamento',
  'error.loadFailed': 'Não foi possível carregar seus orçamentos.',
  'error.retry': 'Tentar novamente',
  'empty.body':
    'Você ainda não tem orçamentos. Crie um para começar a planejar ou peça a alguém para adicionar seu e-mail ao orçamento dessa pessoa, e ele aparecerá aqui.',
  'create.cancelLabel': 'Cancelar novo orçamento',
  'create.placeholder': 'Nome do orçamento, por exemplo Casa',
  'create.nameLabel': 'Nome do novo orçamento',
  'create.button': 'Criar orçamento',
  'create.failed': 'Não foi possível criar o orçamento. Tente novamente.',
  'create.nameRequired': 'Dê um nome ao orçamento',
  'create.nameTooLong': 'Use no máximo {max} caracteres',
  'section.mine': 'Meus orçamentos',
  'section.mineEmpty': 'Você ainda não tem nenhum. “Novo orçamento” cria um.',
  'section.shared': 'Compartilhados comigo',
  'section.sharedEmpty': 'Nada por enquanto. Um orçamento aparece aqui quando o dono adiciona seu e-mail a ele.',
  'section.archived': 'Arquivados ({count})',
  'section.archivedLabel': 'Arquivados, {count}',
  'people.title': 'Pessoas em {name}',
  'people.inviteLabel': 'Convidar pessoas para {name}',
  'card.open': 'Abrir {name}',
  'card.invite': 'Convidar',
  'card.people': 'Pessoas',
  'card.archivedOn': 'Arquivado em {date}',
  'caption.onlyYou': 'Só você',
  'caption.people': { one: '{count} pessoa', other: '{count} pessoas' },
  'caption.sharedBy': 'Compartilhado por {name}',
  'caption.sharedWithYou': 'Compartilhado com você',
  'greeting.welcomeName': 'Boas-vindas, {name}.',
  'greeting.welcome': 'Boas-vindas.',
  'greeting.budgets': 'Seus orçamentos',
};

export default m;
