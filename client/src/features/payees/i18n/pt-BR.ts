import type { Translation } from '@shared/i18n';
import type en from './en';

const m: Translation<typeof en> = {
  'screen.title': 'Gerenciar favorecidos',
  'screen.search': 'Buscar por nome',
  'tabs.payees': 'Favorecidos',
  'tabs.rules': 'Regras de transferência',

  'list.addPlaceholder': 'Adicionar um favorecido…',
  'list.newNameLabel': 'Nome do novo favorecido',
  'list.addLabel': 'Adicionar favorecido',
  'list.noMatch': 'Nenhum favorecido corresponde a “{query}”.',

  'activity.lastUsed': { one: '{count} transação · último uso {date}', other: '{count} transações · último uso {date}' },
  'activity.neverUsed': { one: '{count} transação · nunca usado', other: '{count} transações · nunca usado' },

  'txns.error': 'Não foi possível carregar as transações.',
  'txns.empty': 'Nenhuma transação.',
  'txns.col.date': 'DATA',
  'txns.col.memo': 'OBSERVAÇÃO',
  'txns.col.account': 'CONTA',
  'txns.col.category': 'CATEGORIA',
  'txns.col.amount': 'VALOR',
  'txns.prev': '← Anterior',
  'txns.next': 'Próxima →',
  'txns.page': 'Página {page} de {pages}',

  'merge.title': 'MESCLAR FAVORECIDO',
  'merge.body': {
    one: '“{name}” tem {count} transação. Escolha um favorecido para mesclá-la — a transação passa para esse favorecido.',
    other: '“{name}” tem {count} transações. Escolha um favorecido para mesclá-las — as transações passam para esse favorecido.',
  },
  'merge.search': 'Buscar favorecidos…',
  'merge.targetLabel': 'Favorecido para mesclar',
  'merge.confirm': 'Mesclar',

  'detail.empty': 'Selecione um favorecido para editar os detalhes.',
  'detail.name': 'NOME',
  'detail.activity': 'ATIVIDADE',
  'detail.showTxns': { one: 'Mostrar {count} transação', other: 'Mostrar {count} transações' },
  'detail.hideTxns': { one: 'Ocultar {count} transação', other: 'Ocultar {count} transações' },
  'detail.categorization': 'CATEGORIZAÇÃO',
  'detail.defaultCategory': 'Categoria padrão',
  'detail.defaultCategoryCurrent': 'Categoria padrão atual: {name}',
  'detail.defaultCategoryNone': 'Categoria padrão atual: nenhuma ainda',
  'detail.renaming': 'RENOMEAÇÃO',
  'detail.renamingHint': 'Favorecidos importados que correspondem a esta regra serão renomeados para “{name}”.',
  'detail.hide': 'Ocultar este favorecido',
  'detail.unhide': 'Reexibir este favorecido',
  'detail.mergeInto': 'Mesclar com…',

  'mode.auto.title': 'Seleção automática',
  'mode.auto.sub': 'sugerir uma categoria com base nas transações anteriores',
  'mode.fixed.title': 'Categoria fixa',
  'mode.fixed.sub': 'sempre usar a categoria padrão abaixo',
  'mode.never.title': 'Nunca categorizar',
  'mode.never.sub': 'deixar as novas transações sem categoria',

  'picker.none': 'Nenhuma',

  'rule.contains': 'Contém',
  'rule.is': 'É',
  'rule.containsPlaceholder': 'Contém…',
  'rule.isPlaceholder': 'É…',
  'rule.matcherLabel': 'Tipo de correspondência da renomeação',
  'rule.conditionLabel': 'Condição da renomeação',

  'error.createCategory': 'Não foi possível criar a categoria.',
  'error.rename': 'Não foi possível renomear o favorecido.',
  'error.saveRule': 'Não foi possível salvar a regra de renomeação.',
  'error.add': 'Não foi possível adicionar o favorecido.',
  'error.update': 'Não foi possível atualizar o favorecido.',
  'error.categorization': 'Não foi possível atualizar a categorização.',
  'error.delete': 'Não foi possível excluir o favorecido.',
  'error.merge': 'Não foi possível mesclar os favorecidos.',
};

export default m;
