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
  'one.filedLeft': 'em “Saindo sem categoria”',
  'strip.sending': 'enviando…',
  'strip.title': 'SAINDO SEM CATEGORIA',
  'strip.hint':
    'Nada é enviado até você tocar em Concluir. Se sair da página, você será perguntado antes. Se fechar ou recarregar a aba, não são enviadas: voltam na próxima visita.',
  'strip.done': {
    one: 'Concluir · tirar {count} da lista para todos do orçamento',
    other: 'Concluir · tirar {count} da lista para todos do orçamento',
  },
  'leave.title': 'Linhas em “Saindo sem categoria”',
  'leave.body': {
    one: '{count} transação de {budget} espera para sair da lista para todos naquele orçamento. Enviar agora?',
    other: '{count} transações de {budget} esperam para sair da lista para todos naquele orçamento. Enviar agora?',
  },
  'leave.sending': 'Enviando…',
  'leave.send': 'Enviar e sair',
  'leave.keep': 'Manter e sair',
  'leave.stay': 'Ficar',
  'leave.sendFailed': {
    one: '{count} não pôde ser enviada. Tente de novo, ou mantenha e saia: volta na próxima visita.',
    other: '{count} não puderam ser enviadas. Tente de novo, ou mantenha e saia: voltam na próxima visita.',
  },
  'leave.sentSoFar': {
    one: '{count} enviada.',
    other: '{count} enviadas.',
  },
  'leave.droppedNote': {
    one: 'Outra não pôde ser enviada de vez e saiu da lista.',
    other: '{count} outras não puderam ser enviadas de vez e saíram da lista.',
  },
  'one.skip': 'Deixar sem categoria',
  'one.skipHint': 'Tira da lista para todos do orçamento. Você ainda pode categorizar no registro.',
  'one.undoLast': 'Desfazer a última',
  'one.stateHint': 'Por que sem sugestões: {state}.',
  'one.suggestionA11y': 'Sugestão {rank}: {category}, {percent}% de confiança',
  'one.rowA11y': '{payee}, {amount}',

  undo: 'Desfazer',
  'error.accept': 'Não foi possível categorizar estas transações.',
  'error.skipRefused': '{subject} já foi categorizada em outro lugar, então saiu da lista sozinha.',
  'error.skipRejected': '{subject} não pode ser enviada (sem permissão, ou não existe mais), então saiu da faixa.',
  'toast.sending': 'Estas linhas estão sendo enviadas: não dá mais para desfazer.',
  'error.skip': 'Não foi possível pular esta transação.',
  'error.bundleChanged':
    'Esse pacote mudou de {expected} para {actual} transações. A lista foi atualizada: confira e aceite de novo.',
  'error.bundleChangedNoCounts': 'Esse pacote mudou. A lista foi atualizada: confira e aceite de novo.',
  'error.threshold': 'Não foi possível salvar o limite de confiança.',
  'toast.filed': '{subject} → {category}',
  'toast.skipped':
    '{subject} foi para “Saindo sem categoria”. Nada é enviado até você tocar em Concluir.',
  'undo.done': { one: 'Desfeita {count} transação.', other: 'Desfeitas {count} transações.' },
  'undo.restored': {
    one: 'Desfeitas {count} de {requested} transações.',
    other: 'Desfeitas {count} de {requested} transações.',
  },
  'undo.alreadyRestored': {
    one: '{count} delas já estava restaurada.',
    other: '{count} delas já estavam restauradas.',
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
