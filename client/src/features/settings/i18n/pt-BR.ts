import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'language.title': 'IDIOMA',
  'language.option.system': 'Sistema',
  'language.option.en': 'English',
  'language.option.ptBR': 'Português (Brasil)',

  'pane.root': 'CONFIGURAÇÕES',
  'pane.open': 'ABRIR ORÇAMENTO',
  'pane.edit': 'EDITAR ORÇAMENTO',
  'pane.new': 'NOVO ORÇAMENTO',
  'pane.people': 'PESSOAS',
  'pane.freshStart': 'RECOMEÇO',
  'pane.plan': 'CONFIGURAÇÕES DO PLANO',
  'pane.flags': 'EDITAR MARCADORES',
  'pane.display': 'OPÇÕES DE EXIBIÇÃO',
  'pane.shortcuts': 'ATALHOS DE TECLADO',
  'pane.account': 'CONFIGURAÇÕES DA CONTA',

  'root.kicker': 'ORÇAMENTO',
  'root.budgetFallback': 'Orçamento',
  'root.allBudgets': 'Todos os orçamentos',
  'root.open': 'Abrir orçamento',
  'root.new': 'Novo orçamento',
  'root.planSettings': 'Configurações do plano',
  'root.people': 'Pessoas',
  'root.freshStart': 'Fazer um recomeço',
  'root.payees': 'Gerenciar favorecidos',
  'root.banks': 'Bancos vinculados',
  'root.aiKey': 'Chave de IA',
  'root.backup': 'Exportar / Importar',
  'root.flags': 'Editar marcadores',
  'root.display': 'Opções de exibição',
  'root.hideAmounts': 'Ocultar valores',
  'root.hiddenHint': 'Os valores estão ocultos — toque de novo para mostrá-los.',
  'root.maskHint': 'Toque para ocultar todos os valores até reabrir.',
  'root.shortcuts': 'Atalhos de teclado',
  'root.account': 'Configurações da conta',
  'root.profile': 'Perfil',
  'root.logOut': 'Sair',

  'account.signedInAs': 'Sessão iniciada como',
  'account.back': 'Voltar ao plano',

  'edit.unavailable': 'Orçamento indisponível.',
  'edit.current': 'Orçamento atual',
  'edit.open': 'Abrir',

  'hint.switchFirst': 'Selecione um orçamento primeiro.',
  'hint.ownerOnlyNamed': 'Somente o dono ({name}) pode renomear, arquivar ou excluir este orçamento.',
  'hint.ownerOnly': 'Somente o dono pode renomear, arquivar ou excluir este orçamento.',
  'hint.freshStart':
    'Arquiva "{name}" — renomeado com a data e a hora do arquivamento, com todas as linhas mantidas — e inicia um novo "{name}". Mantidos: contas, saldos das contas vinculadas e histórico até hoje, transações agendadas, metas, categorias e favorecidos. Zerados: valores orçados, notas do mês e atividade das categorias. Os orçamentos arquivados continuam em Abrir orçamento.',
  'hint.manage': 'Arquiva "{name}" — todas as linhas são mantidas. Os orçamentos arquivados continuam em Abrir orçamento.',
  'hint.manageArchived': '"{name}" está arquivado. Desarquive para recuperá-lo ou exclua-o permanentemente.',

  'manage.archive': 'Arquivar orçamento',
  'manage.unarchive': 'Desarquivar orçamento',
  'manage.delete': 'Excluir orçamento…',
  'manage.archiveFailed': 'Não foi possível arquivar o orçamento.',
  'manage.unarchiveFailed': 'Não foi possível desarquivar o orçamento.',

  'delete.title': 'Excluir permanentemente',
  'delete.note': 'Exclui "{name}" e todas as transações, contas, categorias e configurações dele. Isso não pode ser desfeito.',
  'delete.word': 'excluir',
  'delete.placeholder': 'Digite "{word}" para confirmar',
  'delete.inputLabel': 'Digite {word} para confirmar a exclusão permanente',
  'delete.confirm': 'Excluir para sempre',
  'delete.failed': 'Não foi possível excluir o orçamento.',

  'display.bars': 'Barras de progresso',
  'display.barsSub': 'Barras de financiamento sob as categorias do plano',
  'display.hidden': 'Categorias ocultas',
  'display.hiddenSub': 'Mostrar categorias ocultas no Plano',
  'display.closed': 'Contas encerradas',
  'display.closedSub': 'Mostrar o grupo Encerradas na barra de contas',

  'flags.hint': 'Nomes exibidos no menu de marcadores do registro. Em branco, usa o nome da cor.',
  'flags.inputLabel': 'Nome do marcador {color}',

  'fresh.confirm': 'Sim — recomeçar',
  'fresh.start': 'Fazer um recomeço',
  'fresh.failed': 'Não foi possível fazer o recomeço.',

  'new.hint': 'Cria um novo orçamento com um grupo inicial.',
  'new.placeholder': 'Nome do orçamento',
  'new.nameLabel': 'Nome do novo orçamento',
  'new.create': 'Criar orçamento',
  'new.failed': 'Não foi possível criar o orçamento.',

  'open.empty': 'Nenhum orçamento ainda.',
  'open.archived': 'ARQUIVADOS',

  'plan.nameTitle': 'NOME DO PLANO',
  'plan.namePlaceholder': 'Nome do orçamento',
  'plan.saved': 'Salvo.',
  'plan.rename': 'Renomear orçamento',
  'plan.renameFailed': 'Não foi possível renomear o orçamento.',
  'plan.currency': 'MOEDA',
  'plan.placement': 'POSIÇÃO DO SÍMBOLO',
  'plan.numberFormat': 'FORMATO DE NÚMERO',
  'plan.dateFormat': 'FORMATO DE DATA',
  'plan.manage': 'GERENCIAR ORÇAMENTO',

  'shortcuts.close': 'Fechar menus, janelas e este painel',
  'shortcuts.enter': 'Confirmar o campo de valor que está sendo editado',
  'shortcuts.math': 'Operadores de cálculo rápido nos campos de valor',
};

export default m;
