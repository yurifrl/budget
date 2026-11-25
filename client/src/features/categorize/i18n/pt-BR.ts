import type { Translation } from '@shared/i18n';

import type en from './en';

const m: Translation<typeof en> = {
  'screen.title': 'Categorizar',
  'view.bundles': 'Pacotes',
  'view.oneByOne': 'Uma a uma',

  'header.threshold': 'LIMITE DE CONFIANÇA',
  'header.thresholdLabel': 'Limite de confiança',
  'header.thresholdValue': '{percent}%',
  'header.thresholdHint':
    'Sugestões abaixo de {percent}% ficam ocultas para todos neste orçamento. Essas transações vão para “Sem sugestão”.',
  'header.left': 'para categorizar',
  'header.run': 'Classificar',
  'header.running': 'Executando…',
  'header.progressLabel': 'Progresso da classificação',
  'run.classifying': 'Classificando {done} de {total}…',
  'run.starting': 'Iniciando a classificação…',
  'run.activeHint': 'Roda em segundo plano. As sugestões aparecem aqui conforme ficam prontas; você já pode aceitar.',
  'run.unavailable': 'Classificação indisponível',
  'run.allClassified': 'Todas as {count} classificadas',
  'run.nothingLeft': 'Nada para categorizar',
  'run.lastShort': 'Última execução {date} · {suggested} sugestões',
  'run.nextRun': 'Novas importações são classificadas na próxima execução.',
  'run.never': 'Nenhuma classificação ainda.',
  'run.neverHint': 'Execute para receber sugestões de categoria para a fila.',
  'run.reason.ownKey': 'Nenhuma chave de IA está configurada para este orçamento.',
  'run.reason.sharedKey': 'A chave de IA compartilhada está ligada, mas este servidor não tem uma configurada.',
  'run.reason.sharedModel': 'A chave de IA compartilhada está ligada, mas este servidor não tem um modelo escolhido para ela.',
  'run.reason.encryption': 'Este servidor não consegue guardar chaves de IA agora.',
  'run.reason.unreadable': 'A chave de IA do dono do orçamento não pode ser lida neste servidor.',
  'run.reason.noModel': 'A chave de IA do dono do orçamento não tem um modelo escolhido.',
  'run.reason.unknown': 'As sugestões de categoria estão indisponíveis agora.',
  'run.confirmTitle': 'Classificar agora?',
  'run.confirmBody':
    'Isto lê as transações sem categoria com a chave de IA do dono do orçamento e gasta crédito de IA dessa conta. Só sugere: nada é categorizado até você aceitar.',
  'run.confirmGo': 'Classificar',
  'run.startedFailed': 'Não foi possível iniciar a classificação.',

  'empty.title': 'Adicione uma chave de IA para receber sugestões',
  'empty.body':
    'O Categorizar pede a um modelo de IA para ler cada transação sem categoria e propor até três categorias. Agora nada novo pode ser classificado, então não há sugestões para mostrar.',
  'banner.noKeyTitle': 'Classificação indisponível',
  'banner.noKeyBody': 'As sugestões já feitas continuam abaixo; transações novas não recebem nenhuma até adicionar uma chave.',
  'empty.addKey': 'Adicionar uma chave de IA',
  'empty.byHand': 'Categorizar à mão',
  'empty.footnote': {
    one: 'A chave fica guardada no servidor e é usada só nas classificações. {count} transação está esperando.',
    other: 'A chave fica guardada no servidor e é usada só nas classificações. {count} transações estão esperando.',
  },

  'queue.subtitle': {
    one: '{count} transação sem categoria · sugestões prontas para {ready}',
    other: '{count} transações sem categoria · sugestões prontas para {ready}',
  },

  'bundles.acceptAllTitle': {
    one: '{count} transação em {bundles} pacote está em {percent}% ou mais',
    other: '{count} transações em {bundles} pacotes estão em {percent}% ou mais',
  },
  'bundles.acceptAllBody':
    'Um clique categoriza todas. Você pode desfazer, e cada uma continua editável no registro.',
  'bundles.acceptAll': {
    one: 'Aceitar tudo acima do limite ({count} transação)',
    other: 'Aceitar tudo acima do limite ({count} transações)',
  },
  'bundles.sectionTitle': 'PACOTES',
  'bundles.sectionHint': 'mesmo favorecido + mesma sugestão principal · ordenado pelo número de transações · clique para abrir',
  'bundles.showMore': {
    one: 'Mostrar mais {count} pacote ({transactions} transação)',
    other: 'Mostrar mais {count} pacotes ({transactions} transações)',
  },
  'bundles.showLess': 'Mostrar menos pacotes',

  'bundle.meta': { one: '{count} transação · {range}', other: '{count} transações · {range}' },
  'bundle.dateRange': '{first} – {last}',
  'bundle.accept': 'Aceitar pacote',
  'bundle.rowsLoading': 'Carregando transações…',
  'bundle.rowsFailed': 'Não foi possível carregar as transações deste pacote.',
  'bundle.loadMore': 'Mostrar mais transações',
  'bundle.expand': 'Abrir {payee}',
  'bundle.collapse': 'Fechar {payee}',
  'chip.label': '{category} {percent}%',
  'chip.a11y': 'Categorizar como {category}, {percent}% de confiança',

  'noSuggestion.title': 'Sem sugestão',
  'noSuggestion.hint': {
    one: '{count} transação · nada chegou a {percent}%, escolha à mão ou baixe o limite',
    other: '{count} transações · nada chegou a {percent}%, escolha à mão ou baixe o limite',
  },
  'noSuggestion.truncated': 'Mostrando as primeiras {shown} de {count}.',

  'row.chooseCategory': 'Escolher categoria…',
  'row.chooseA11y': 'Escolher uma categoria para {payee}',
  'row.unnamed': 'Transação sem nome',
  'manual.belowThreshold': 'abaixo do limite',
  'manual.noSuggestion': 'sem sugestão',
  'manual.failed': 'a classificação falhou',
  'manual.notClassified': 'não classificada',

  'queue.loading': 'Carregando a fila…',
  'queue.updating': 'Atualizando a lista com o novo limite…',
  'queue.failed': 'Não foi possível carregar a fila.',
  'queue.empty': 'Nada para categorizar.',

  'merchant.name': 'Estabelecimento',
  'merchant.legalName': 'Razão social',
  'merchant.cnpj': 'CNPJ',
  'merchant.businessCategory': 'Categoria do banco',
  'merchant.operationType': 'Tipo de operação',
  'merchant.counterparty': 'Contraparte do PIX',

  'one.queueTitle': 'Fila',
  'one.queueLeft': '{count} restantes',
  'one.queueOrder': 'Maior confiança primeiro',
  'one.progress': '{position} de {total}',
  'one.moreBelow': {
    one: 'mais {count} abaixo',
    other: 'mais {count} abaixo',
  },
  'one.allDone': 'Tudo pronto. Nada mais para categorizar.',
  'one.keys.enterKey': 'Enter',
  'one.keys.pick': 'escolher',
  'one.keys.confirm': 'confirmar',
  'one.keys.skip': 'deixar de fora',
  'one.keys.search': 'buscar',
  'one.keys.undo': 'desfazer',
  'one.date': 'DATA',
  'one.account': 'CONTA',
  'one.memo': 'OBSERVAÇÃO',
  'one.raw': 'DESCRIÇÃO ORIGINAL DO BANCO',
  'one.merchant': 'ESTABELECIMENTO',
  'one.noMemo': '—',
  'one.suggestions': 'SUGESTÕES · TECLE O NÚMERO OU CLIQUE PARA CATEGORIZAR E IR PARA A PRÓXIMA',
  'one.manualOnly': 'SEM SUGESTÃO PARA ESTA · ESCOLHA UMA CATEGORIA',
  'one.search': 'Buscar outra categoria…',
  'one.searchFirst': 'Buscar uma categoria…',
  'one.confirm': 'Confirmar {category}',
  'one.filedTo': 'em {category}',
  'one.filedLeft': 'deixada sem categoria',
  'one.skip': 'Deixar sem categoria',
  'one.skipHint': 'Tira da lista para todos do orçamento. Você ainda pode categorizar no registro.',
  'one.undoLast': 'Desfazer a última',
  'one.stateHint': 'Por que sem sugestões: {state}.',
  'one.suggestionA11y': 'Sugestão {rank}: {category}, {percent}% de confiança',
  'one.rowA11y': '{payee}, {amount}',

  undo: 'Desfazer',
  'error.accept': 'Não foi possível categorizar estas transações.',
  'error.skip': 'Não foi possível pular esta transação.',
  'error.bundleChanged':
    'Esse pacote mudou de {expected} para {actual} transações. A lista foi atualizada: confira e aceite de novo.',
  'error.bundleChangedNoCounts': 'Esse pacote mudou. A lista foi atualizada: confira e aceite de novo.',
  'error.threshold': 'Não foi possível salvar o limite de confiança.',
  'toast.filed': '{subject} → {category}',
  'toast.skipped':
    'Deixando {subject} sem categoria. Não voltará a esta lista, para ninguém do orçamento.',
  'undo.done': { one: 'Desfeita {count} transação.', other: 'Desfeitas {count} transações.' },
  'undo.restored': {
    one: 'Desfeitas {count} de {requested} transações.',
    other: 'Desfeitas {count} de {requested} transações.',
  },
  'undo.changedSince': {
    one: '{count} mudou depois e foi deixada como está.',
    other: '{count} mudaram depois e foram deixadas como estão.',
  },
  'undo.notReached': {
    one: '{count} não pôde ser desfeita agora: tente Desfazer de novo.',
    other: '{count} não puderam ser desfeitas agora: tente Desfazer de novo.',
  },
  'toast.filedCount': { one: '{count} transação categorizada', other: '{count} transações categorizadas' },
  'toast.bundle': {
    one: '{payee} · {count} transação → {category}',
    other: '{payee} · {count} transações → {category}',
  },
};
export default m;
