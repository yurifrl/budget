export default {
  // CategorizeScreen
  'screen.title': 'Categorize',
  'view.bundles': 'Bundles',
  'view.oneByOne': 'One by one',

  // Header: threshold + run
  'header.threshold': 'CONFIDENCE THRESHOLD',
  'header.thresholdLabel': 'Confidence threshold',
  'header.thresholdValue': '{percent}%',
  'header.thresholdHint':
    'Suggestions below {percent}% are hidden for everyone in this budget. Those rows land in “No suggestion”.',
  'header.left': 'left to categorize',
  'header.run': 'Run classification',
  'header.running': 'Running…',
  'header.progressLabel': 'Classification progress',
  'run.classifying': 'Classifying {done} of {total}…',
  'run.starting': 'Starting the classification…',
  'run.activeHint': 'Runs in the background. Suggestions appear here as they are ready; you can start accepting now.',
  'run.unavailable': 'Classification unavailable',
  'run.allClassified': 'All {count} classified',
  'run.nothingLeft': 'Nothing left to categorize',
  'run.lastShort': 'Last run {date} · {suggested} suggestions',
  'run.nextRun': 'New imports are classified on the next run.',
  'run.never': 'No classification run yet.',
  'run.neverHint': 'Run it to get category suggestions for the queue.',
  'run.reason.ownKey': 'No AI key is set up for this budget.',
  'run.reason.sharedKey': 'The shared AI key is turned on, but this server has none configured.',
  'run.reason.sharedModel': 'The shared AI key is turned on, but this server has no model chosen for it.',
  'run.reason.encryption': 'This server cannot store AI keys right now.',
  'run.reason.unreadable': 'The budget owner’s AI key cannot be read on this server.',
  'run.reason.noModel': 'The budget owner’s AI key has no model chosen.',
  'run.reason.unknown': 'Category suggestions are unavailable right now.',
  'run.confirmTitle': 'Run classification?',
  'run.confirmBody':
    'This reads the uncategorized transactions with the budget owner’s AI key and uses AI credit on that account. It only suggests: nothing is filed until you accept it.',
  'run.confirmGo': 'Run classification',
  'run.startedFailed': 'Could not start the classification.',

  // Empty state: AI unavailable
  'empty.title': 'Add an AI key to get suggestions',
  'empty.body':
    'Categorize asks an AI model to read each uncategorized transaction and propose up to three categories. Right now nothing new can be classified, so there are no suggestions to show.',
  'banner.noKeyTitle': 'Classification is unavailable',
  'banner.noKeyBody': 'Suggestions already made stay below; new transactions get none until a key is added.',
  'empty.addKey': 'Add an AI key',
  'empty.byHand': 'Categorize by hand',
  'empty.footnote': {
    one: 'The key is stored on the server and used only for classification runs. {count} transaction is waiting.',
    other: 'The key is stored on the server and used only for classification runs. {count} transactions are waiting.',
  },

  // Header subtitle: the queue size and how many rows already have a suggestion
  'queue.subtitle': {
    one: '{count} uncategorized transaction · suggestions ready for {ready}',
    other: '{count} uncategorized transactions · suggestions ready for {ready}',
  },

  // Bulk accept banner
  'bundles.acceptAllTitle': {
    one: '{count} transaction in {bundles} bundle is at {percent}% or above',
    other: '{count} transactions in {bundles} bundles are at {percent}% or above',
  },
  'bundles.acceptAllBody':
    'One click files them all. You can undo, and each one stays editable in the register.',
  'bundles.acceptAll': {
    one: 'Accept all above threshold ({count} transaction)',
    other: 'Accept all above threshold ({count} transactions)',
  },
  'bundles.sectionTitle': 'BUNDLES',
  'bundles.sectionHint': 'same payee + same top suggestion · sorted by number of transactions · click a row to open it',
  'bundles.showMore': {
    one: 'Show {count} more bundle ({transactions} transaction)',
    other: 'Show {count} more bundles ({transactions} transactions)',
  },
  'bundles.showLess': 'Show fewer bundles',

  // Bundle cards and their expanded rows
  'bundle.meta': { one: '{count} transaction · {range}', other: '{count} transactions · {range}' },
  'bundle.dateRange': '{first} – {last}',
  'bundle.accept': 'Accept bundle',
  'bundle.rowsLoading': 'Loading rows…',
  'bundle.rowsFailed': 'Could not load this bundle’s rows.',
  'bundle.loadMore': 'Show more rows',
  'bundle.expand': 'Open {payee}',
  'bundle.collapse': 'Close {payee}',
  'chip.label': '{category} {percent}%',
  'chip.a11y': 'File as {category}, {percent}% confidence',

  // No-suggestion group (manual pick)
  'noSuggestion.title': 'No suggestion',
  'noSuggestion.hint': {
    one: '{count} transaction · nothing reached {percent}%, pick by hand or lower the threshold',
    other: '{count} transactions · nothing reached {percent}%, pick by hand or lower the threshold',
  },
  'noSuggestion.truncated': 'Showing the first {shown} of {count}.',

  // Rows
  'row.chooseCategory': 'Choose category…',
  'row.chooseA11y': 'Choose a category for {payee}',
  'row.unnamed': 'Unnamed transaction',
  'manual.belowThreshold': 'below the threshold',
  'manual.noSuggestion': 'no suggestion',
  'manual.failed': 'classification failed',
  'manual.notClassified': 'not classified',

  // Queue states
  'queue.loading': 'Loading the queue…',
  'queue.updating': 'Updating the list for the new threshold…',
  'queue.failed': 'Could not load the queue.',
  'queue.empty': 'Nothing left to categorize.',

  // Merchant panel: only the facts the bank sent are shown (never a map)
  'merchant.name': 'Merchant',
  'merchant.legalName': 'Legal name',
  'merchant.cnpj': 'CNPJ',
  'merchant.businessCategory': "Bank's category",
  'merchant.operationType': 'Operation type',
  'merchant.counterparty': 'PIX counterparty',

  // One by one
  'one.queueTitle': 'Queue',
  'one.queueLeft': '{count} left',
  'one.queueOrder': 'Highest confidence first',
  'one.progress': '{position} of {total}',
  'one.moreBelow': {
    one: '{count} more below',
    other: '{count} more below',
  },
  'one.allDone': 'All done. Nothing left to categorize.',
  'one.keys.enterKey': 'Enter',
  'one.keys.pick': 'pick',
  'one.keys.confirm': 'confirm',
  'one.keys.skip': 'leave out',
  'one.keys.search': 'search',
  'one.keys.undo': 'undo',
  'one.date': 'DATE',
  'one.account': 'ACCOUNT',
  'one.memo': 'MEMO',
  'one.raw': 'RAW BANK DESCRIPTION',
  'one.merchant': 'MERCHANT',
  'one.noMemo': '—',
  'one.suggestions': 'SUGGESTIONS · PRESS THE NUMBER OR CLICK TO FILE AND GO TO THE NEXT',
  'one.manualOnly': 'NO SUGGESTION FOR THIS ONE · PICK A CATEGORY',
  'one.search': 'Search another category…',
  'one.searchFirst': 'Search a category…',
  'one.confirm': 'Confirm {category}',
  'one.filedTo': 'filed to {category}',
  'one.filedLeft': 'left uncategorized',
  'one.skip': 'Leave uncategorized',
  'one.skipHint': 'Takes it off this list for everyone in the budget. You can still categorize it in the register.',
  'one.undoLast': 'Undo last',
  'one.stateHint': 'Why no chips: {state}.',
  'one.suggestionA11y': 'Suggestion {rank}: {category}, {percent}% confidence',
  'one.rowA11y': '{payee}, {amount}',

  // Actions and outcomes
  undo: 'Undo',
  'error.accept': 'Could not file these transactions.',
  'error.skip': 'Could not skip this transaction.',
  'error.bundleChanged':
    'That bundle changed from {expected} to {actual} transactions. The list is updated: check it and accept again.',
  'error.bundleChangedNoCounts': 'That bundle changed. The list is updated: check it and accept again.',
  'error.threshold': 'Could not save the confidence threshold.',
  'toast.filed': '{subject} → {category}',
  'toast.skipped':
    'Leaving {subject} uncategorized. It will not come back to this list, for anyone in the budget.',
  // Undo outcomes
  'undo.done': { one: 'Undid {count} transaction.', other: 'Undid {count} transactions.' },
  'undo.restored': {
    one: 'Undid {count} of {requested} transactions.',
    other: 'Undid {count} of {requested} transactions.',
  },
  'undo.changedSince': {
    one: '{count} changed since and was left as it is.',
    other: '{count} changed since and were left as they are.',
  },
  'undo.notReached': {
    one: '{count} could not be undone right now: try Undo again.',
    other: '{count} could not be undone right now: try Undo again.',
  },
  'toast.filedCount': { one: '{count} transaction filed', other: '{count} transactions filed' },
  'toast.bundle': {
    one: '{payee} · {count} transaction → {category}',
    other: '{payee} · {count} transactions → {category}',
  },
} as const;
