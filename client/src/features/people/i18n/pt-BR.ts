import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'picker.person': 'Pessoa',
  'picker.option': '{prefix} {name}',

  'filter.title': 'Filtrar por pessoa',
  'filter.label': 'Pessoa',
  'filter.everyone': 'Todos',
  'filter.option': 'Pessoa {name}',
  'filter.addPeople': 'Adicionar pessoas',
  'filter.ownsNone': 'Nenhuma categoria atribuída a {name} ainda — abra uma categoria e defina a Pessoa. As compartilhadas aparecem abaixo.',
  'filter.captionShared': 'Categorias compartilhadas · Atividade de contas compartilhadas',
  'filter.captionPerson': 'Categorias de {name} + compartilhadas · Atividade das contas de {name}',

  'prompt.question': 'Planejando com alguém?',
  'prompt.link': 'Adicionar pessoas →',
  'prompt.dismiss': 'Dispensar o convite para adicionar pessoas',

  'pane.noBudget': 'Nenhum orçamento selecionado.',
  'pane.hint': 'Todos aqui veem e editam tudo neste orçamento.',
  'pane.invitedHint': 'As pessoas convidadas encontram este orçamento na página inicial quando entram com esse e-mail. Adicioná-las não envia mensagem nem cria um acesso para elas.',
  'pane.placeholderHint': 'Pessoas sem e-mail servem só para agrupar — vincule o e-mail depois, quando elas se conectarem.',
  'pane.ownerOnly': 'Só o dono pode remover pessoas.',
  'pane.enterName': 'Digite um nome',

  'add.title': 'ADICIONAR UMA PESSOA',
  'add.namePlaceholder': 'Nome',
  'add.nameLabel': 'Nome da pessoa a adicionar',
  'add.emailPlaceholder': 'E-mail (opcional — adicione depois)',
  'add.emailLabel': 'E-mail da pessoa a adicionar (opcional)',
  'add.button': 'Adicionar pessoa',
  'add.adding': 'Adicionando…',

  'badge.owner': 'DONO',
  'badge.you': 'VOCÊ',
  'badge.invited': 'CONVITE',
  'badge.noEmail': 'SEM E-MAIL',

  'row.notConnected': 'Ainda não conectou',
  'row.editProfile': 'Editar perfil',
  'row.linkEmail': 'Vincular e-mail',
  'row.linkEmailLabel': 'Vincular e-mail de {name}',
  'row.rename': 'Renomear',
  'row.renameLabel': 'Renomear {name}',
  'row.removeLabel': 'Remover {name}',

  'edit.emailPlaceholder': 'pessoa@exemplo.com',
  'edit.emailLabel': 'E-mail de {name}',
  'edit.nameLabel': 'Novo nome de {name}',
  'edit.linkWarning': 'Se este e-mail já pertencer a alguém no app, essa pessoa assume as contas e categorias de {name} e {name} some da lista.',
  'edit.saveEmailLabel': 'Salvar e-mail',
  'edit.saveNameLabel': 'Salvar nome',
  'edit.link': 'Vincular',
  'edit.save': 'Salvar',

  'remove.confirm': 'Remover {name}? A pessoa perde o acesso a este orçamento e as contas dela passam para Compartilhado.',
  'remove.cancelLabel': 'Cancelar remoção',
  'remove.yesLabel': 'Sim, remover {name}',

  'error.add': 'Não foi possível adicionar a pessoa.',
  'error.link': 'Não foi possível vincular o e-mail.',
  'error.rename': 'Não foi possível renomear a pessoa.',
  'error.remove': 'Não foi possível remover a pessoa.',
};

export default m;
