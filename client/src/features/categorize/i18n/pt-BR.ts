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
  'queue.left': {
    one: '{count} transação sem categoria',
    other: '{count} transações sem categoria',
  },
  'queue.answers': {
    one: '{count} resposta de transferência',
    other: '{count} respostas de transferência',
  },
  /** Com respostas de transferência esperando: contadas à parte da fila. */
  'queue.subtitleMixed': '{left} · {answers} · sugestões prontas para {ready}',

  'bundles.acceptAllTitle': {
    one: '{count} transação em {bundles} pacote está em {percent}% ou mais',
    other: '{count} transações em {bundles} pacotes estão em {percent}% ou mais',
  },
  'bundles.acceptAllBody':
    'Um clique categoriza todas. Transferências não entram: responda-as acima, em Transferências. Você pode desfazer, e cada uma continua editável no registro.',
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
  'bundle.pickCategory': 'Escolher uma categoria para {payee}',
  'chip.label': '{category} {percent}%',
  'chip.a11y': 'Categorizar como {category}, {percent}% de confiança',
  'chip.percent': '{percent}%',
  'chip.percentA11y': '{percent}% de confiança',

  'noSuggestion.title': 'Sem sugestão',
  'noSuggestion.hint': {
    one: '{count} transação · nada chegou a {percent}%, escolha à mão ou baixe o limite',
    other: '{count} transações · nada chegou a {percent}%, escolha à mão ou baixe o limite',
  },
  'noSuggestion.truncated': 'Mostrando as primeiras {shown} de {count}.',
  'noSuggestion.showAll': 'Mostrar todas',
  'noSuggestion.showAllLoading': 'Lendo o restante…',
  'noSuggestion.loadFailed': 'Não foi possível ler o restante da fila.',

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
  /** O mesmo contador com as respostas do Jev ao lado: "12 restantes · 2 respostas". */
  'one.queueLeftMixed': '{left} · {answers}',
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

  // Run card (Jev)
  'run.title': 'CATEGORIZAR COM O JEV',
  'run.button': 'Executar Jev',
  'run.confirmTitle': 'EXECUTAR JEV',
  'run.confirmBody': {
    one: 'Perguntar ao Jev sobre {count} transação? As respostas aparecem nesta página para você aceitar ou pular — uma categoria nos pacotes e na fila, uma transferência em Transferências; nada é aplicado automaticamente.',
    other: 'Perguntar ao Jev sobre {count} transações? As respostas aparecem nesta página para você aceitar ou pular — uma categoria nos pacotes e na fila, uma transferência em Transferências; nada é aplicado automaticamente.',
  },
  'run.countLabel': 'Quantas enviar',
  'run.countAll': 'Todas as que esperam ({count})',
  'run.countInvalid': 'Digite um número inteiro a partir de 1, ou deixe o campo vazio para todas as que esperam.',
  'run.countClamped': 'Só {max} podem ir agora: esta execução pega {max}.',
  'run.checking': 'Verificando o que pode ser enviado agora…',
  'run.hourSpent': 'O limite por hora acabou: em cerca de {minutes} min abre uma vaga.',
  'run.hourTrims':
    'O limite de {limit} transações por hora permite {count} agora; o resto espera uma vaga.',
  'run.confirmStart': 'Executar',
  'run.never': 'Nenhuma execução ainda.',
  'run.waiting': 'Na fila…',
  'run.running': 'Perguntando ao Jev…',
  'run.finished': 'A última execução terminou.',
  'run.finishedCount':
    'Execução concluída: {done} de {total} sugeridas, {failures} sem resposta.',
  'run.failed': 'A última execução falhou.',
  'run.cancelled': 'A última execução foi cancelada.',
  'run.progress': { one: '{done} de {total} transação', other: '{done} de {total} transações' },
  'run.failures': {
    one: '{count} não pôde ser respondida; uma execução posterior tenta de novo.',
    other: '{count} não puderam ser respondidas; uma execução posterior tenta de novo.',
  },
  'run.noKeyShared':
    'Nenhuma chave da API do Jev ainda: salve a sua para categorizar com o Jev, ou peça a chave compartilhada.',
  'run.noKeyServer': 'Nenhuma chave da API do Jev ainda: este servidor não tem chave compartilhada, então salve a sua.',
  'run.noKeyUnreadable': 'Sua chave da API do Jev não pode ser lida neste servidor. Salve de novo.',
  'run.noKeyOwner': 'Nenhuma chave da API do Jev pode ser usada: este orçamento não tem dono, então não há chave de onde partir.',
  'run.failure.keyRejected': 'A execução parou: o Jev recusou a chave. Confira no OpenRouter e salve de novo.',
  'run.failure.keyRejectedMember':
    'A execução parou: o Jev recusou a chave do dono do orçamento. Só o dono pode conferi-la no OpenRouter e salvar de novo.',
  'run.failure.noCredits': 'A execução parou: a conta do OpenRouter por trás da chave está sem créditos.',
  'run.failure.noCreditsMember':
    'A execução parou: a conta do OpenRouter por trás da chave do dono do orçamento está sem créditos. Só o dono pode adicionar créditos ou usar outra chave.',
  'run.failure.jevUnavailable': 'A execução parou: o Jev não estava disponível. Tente de novo daqui a pouco.',
  'run.failure.tooManyCategories':
    'A execução parou: este orçamento tem mais categorias do que uma pergunta do Jev aceita.',
  'run.failure.noCategories': 'A execução parou: este orçamento não tem categoria que uma sugestão possa indicar.',
  'run.failure.notConfigured': 'A execução parou: nenhuma chave da API do Jev pôde ser usada. Salve uma para categorizar.',
  'run.failure.notConfiguredMember':
    'A execução parou: nenhuma chave da API do Jev pôde ser usada. O dono deste orçamento precisa salvar uma para categorizar.',
  'run.failure.internal': 'A execução parou de forma inesperada. Inicie de novo.',
  'run.noKeyMember':
    'Nenhuma chave da API do Jev pode ser usada: o dono deste orçamento precisa salvar uma, ou a chave compartilhada precisa estar ligada.',
  'run.keyLink': 'Chave da API do Jev',
  'run.empty':
    'Nada a perguntar agora: nenhuma transação esperando resposta do Jev, precise ela de categoria ou pareça transferência.',
  'run.startFailed': 'Não foi possível iniciar a execução.',
  'run.loadFailed': 'Não foi possível ler o estado da execução.',

  // Transferências: os pares do matcher e as respostas "é transferência" do Jev,
  // acima dos bundles de categoria (as do Jev agrupadas pelo par de contas).
  'transfer.title': 'TRANSFERÊNCIAS',
  'transfer.jevHeading': 'O JEV DIZ TRANSFERÊNCIA',
  'transfer.matcherHeading': 'PARECE TRANSFERÊNCIA',
  'transfer.to': 'Transferência para {account}',
  'transfer.from': 'Transferência de {account}',
  'transfer.pair': '{out} → {in}',
  'transfer.choose': 'Escolher par',
  'transfer.count': { one: '{count} transação', other: '{count} transações' },
  'transfer.percent': '{percent}%',
  'transfer.accept': 'Aceitar',
  'transfer.acceptPair': 'Aceitar todas ({count})',
  'transfer.refuse': 'Não é transferência',
  'transfer.skip': 'Pular',
  'transfer.subject': '{payee} · {amount}',
  'transfer.filedTo': 'Transferência · {account}',
  'transfer.refusedToast': 'Marcada como não sendo transferência',
  'transfer.linkedCount': { one: '{count} transferência ligada', other: '{count} transferências ligadas' },
  'transfer.loadFailed': 'Não foi possível ler as transferências sugeridas pelo Jev.',
  'transfer.matcherFailed': 'Não foi possível ler os pares de transferência encontrados para você.',
  'transfer.refuseFailed': 'Não foi possível registrar “não é transferência”.',
  'transfer.errorRefused': 'Esta linha foi respondida como “não é transferência”; ligue no registro para torná-la uma.',
  'transfer.errorCategorized': 'Esta linha já tem categoria, então não é mais transferência.',
  'transfer.errorNoCategory': 'Esta linha não precisa mais de categoria: já é transferência.',
  /** Um a um: os pares não são respondidos ali. */
  'transfer.paneNote': {
    one: '{count} par parece transferência: reveja em Pacotes',
    other: '{count} pares parecem transferências: reveja em Pacotes',
  },
  'transfer.focusLabel': 'TRANSFERÊNCIA',
  'transfer.focusHint': 'Aceitar liga os dois lados e não grava categoria.',

};
export default m;
