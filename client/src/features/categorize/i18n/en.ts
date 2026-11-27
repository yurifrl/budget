export default {
  // CategorizeScreen
  'screen.title': 'Categorize',
  'view.bundles': 'Bundles',
  'view.oneByOne': 'One by one',

  // Header: threshold
  'header.threshold': 'CONFIDENCE THRESHOLD',
  'header.thresholdLabel': 'Confidence threshold',
  'header.thresholdValue': '{percent}%',
  'header.thresholdHint':
    'Suggestions below {percent}% are hidden for everyone in this budget. Those rows land in “No suggestion”.',
  'header.left': 'left to categorize',

  // Header subtitle: the queue size, Jev's transfer answers and how many rows
  // already have a suggestion. Each number names its own noun, and the catalog
  // picks a plural branch from one `count` only, so each noun is its own message
  // and the subtitle joins them.
  'queue.subtitle': {
    one: '{count} uncategorized transaction · suggestions ready for {ready}',
    other: '{count} uncategorized transactions · suggestions ready for {ready}',
  },
  'queue.left': {
    one: '{count} uncategorized transaction',
    other: '{count} uncategorized transactions',
  },
  'queue.answers': {
    one: '{count} transfer answer',
    other: '{count} transfer answers',
  },
  /** With transfer answers waiting: they are counted apart from the queue. */
  'queue.subtitleMixed': '{left} · {answers} · suggestions ready for {ready}',
  // Bulk accept banner
  'bundles.acceptAllTitle': {
    one: '{count} transaction in {bundles} bundle is at {percent}% or above',
    other: '{count} transactions in {bundles} bundles are at {percent}% or above',
  },
  'bundles.acceptAllBody':
    'One click files them all. Transfer rows are not included: answer them in Transfers above. You can undo, and each one stays editable in the register.',
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
  'bundle.pickCategory': 'Choose a category for {payee}',
  'chip.label': '{category} {percent}%',
  'chip.a11y': 'File as {category}, {percent}% confidence',
  'chip.percent': '{percent}%',
  'chip.percentA11y': '{percent}% confidence',

  // No-suggestion group (manual pick)
  'noSuggestion.title': 'No suggestion',
  'noSuggestion.hint': {
    one: '{count} transaction · nothing reached {percent}%, pick by hand or lower the threshold',
    other: '{count} transactions · nothing reached {percent}%, pick by hand or lower the threshold',
  },
  'noSuggestion.truncated': 'Showing the first {shown} of {count}.',
  'noSuggestion.showAll': 'Show all',
  'noSuggestion.showAllLoading': 'Reading the rest…',
  'noSuggestion.loadFailed': 'Could not read the rest of the queue.',

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
  /** The same counter with Jev's transfer answers beside it: "12 left · 2 answers". */
  'one.queueLeftMixed': '{left} · {answers}',
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
  'one.filedLeft': 'in “Leaving uncategorized”',
  'strip.sending': 'sending…',
  'strip.title': 'LEAVING UNCATEGORIZED',
  'strip.hint':
    'Nothing is sent until you press Done. If you leave the page you will be asked first. Close or reload the tab and they are not sent: they come back next visit.',
  'strip.done': {
    one: 'Done · remove {count} from the list for everyone in the budget',
    other: 'Done · remove {count} from the list for everyone in the budget',
  },
  'leave.title': 'Rows in “Leaving uncategorized”',
  'leave.body': {
    one: '{count} transaction of {budget} is waiting to leave the list for everyone in that budget. Send it now?',
    other: '{count} transactions of {budget} are waiting to leave the list for everyone in that budget. Send them now?',
  },
  'leave.sending': 'Sending…',
  'leave.send': 'Send and leave',
  'leave.keep': 'Keep them and leave',
  'leave.stay': 'Stay',
  'leave.sendFailed': {
    one: '{count} could not be sent. Try again, or keep it and leave: it comes back next visit.',
    other: '{count} could not be sent. Try again, or keep them and leave: they come back next visit.',
  },
  'leave.sentSoFar': {
    one: '{count} sent.',
    other: '{count} sent.',
  },
  'leave.droppedNote': {
    one: '{count} more could not be sent for good and left the list.',
    other: '{count} more could not be sent for good and left the list.',
  },
  'one.skip': 'Leave uncategorized',
  'one.skipHint': 'Takes it off this list for everyone in the budget. You can still categorize it in the register.',
  'one.undoLast': 'Undo last',
  'one.stateHint': 'Why no chips: {state}.',
  'one.suggestionA11y': 'Suggestion {rank}: {category}, {percent}% confidence',
  'one.rowA11y': '{payee}, {amount}',

  // Actions and outcomes
  undo: 'Undo',
  'error.accept': 'Could not file these transactions.',
  'error.skipRefused': '{subject} was already categorized elsewhere, so it left the list on its own.',
  'error.skipRejected': '{subject} cannot be sent (not allowed, or it no longer exists), so it left the strip.',
  'toast.sending': 'These rows are being sent: they can no longer be undone.',
  'error.skip': 'Could not skip this transaction.',
  'error.bundleChanged':
    'That bundle changed from {expected} to {actual} transactions. The list is updated: check it and accept again.',
  'error.bundleChangedNoCounts': 'That bundle changed. The list is updated: check it and accept again.',
  'error.threshold': 'Could not save the confidence threshold.',
  'toast.filed': '{subject} → {category}',
  'toast.skipped':
    '{subject} moved to “Leaving uncategorized”. Nothing is sent until you press Done.',
  // Undo outcomes
  'undo.done': { one: 'Undid {count} transaction.', other: 'Undid {count} transactions.' },
  'undo.restored': {
    one: 'Undid {count} of {requested} transactions.',
    other: 'Undid {count} of {requested} transactions.',
  },
  'undo.alreadyRestored': {
    one: '{count} of them was already restored.',
    other: '{count} of them were already restored.',
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

  // Run card (Jev)
  'run.title': 'CATEGORIZE WITH JEV',
  'run.button': 'Run Jev',
  'run.confirmTitle': 'RUN JEV',
  'run.confirmBody': {
    one: 'Ask Jev about {count} transaction? The answers land on this page for you to accept or skip — a category in the bundles and the queue, a transfer in Transfers; nothing is applied automatically.',
    other: 'Ask Jev about {count} transactions? The answers land on this page for you to accept or skip — a category in the bundles and the queue, a transfer in Transfers; nothing is applied automatically.',
  },
  'run.countLabel': 'How many to send',
  'run.countAll': 'All waiting ({count})',
  'run.countInvalid': 'Type a whole number from 1, or leave the field empty for everything waiting.',
  'run.countClamped': 'Only {max} can go now: this run takes {max}.',
  'run.checking': 'Checking what can be sent now…',
  'run.hourSpent': 'The hourly limit is used up: in about {minutes} min a slot frees.',
  'run.hourTrims':
    'The hourly limit of {limit} transactions allows {count} now; the rest waits for a free slot.',
  'run.confirmStart': 'Start run',
  'run.never': 'No run yet.',
  'run.waiting': 'Queued…',
  'run.running': 'Asking Jev…',
  'run.finished': 'The last run finished.',
  'run.finishedCount':
    'Run finished: {done} of {total} suggested, {failures} could not be answered.',
  'run.failed': 'The last run failed.',
  'run.cancelled': 'The last run was cancelled.',
  'run.progress': { one: '{done} of {total} transaction', other: '{done} of {total} transactions' },
  'run.failures': {
    one: '{count} could not be answered; a later run retries it.',
    other: '{count} could not be answered; a later run retries them.',
  },
  'run.noKeyShared':
    'No Jev API key yet: save your own to categorize with Jev, or ask for the shared key.',
  'run.noKeyServer': 'No Jev API key yet: this server has no shared key, so save your own.',
  'run.noKeyUnreadable': 'Your Jev API key cannot be read on this server. Save it again.',
  'run.noKeyOwner': 'No Jev API key can be used: this budget has no owner to take one from.',
  'run.failure.keyRejected': 'The run stopped: Jev refused the key. Check it in OpenRouter and save it again.',
  'run.failure.keyRejectedMember':
    "The run stopped: Jev refused the budget owner's key. Only the owner can check it in OpenRouter and save it again.",
  'run.failure.noCredits': 'The run stopped: the OpenRouter account behind the key has no credits left.',
  'run.failure.noCreditsMember':
    "The run stopped: the OpenRouter account behind the budget owner's key has no credits left. Only the owner can top it up or use another key.",
  'run.failure.jevUnavailable': 'The run stopped: Jev was unavailable. Try again in a little while.',
  'run.failure.tooManyCategories':
    'The run stopped: this budget has more categories than one Jev question can offer.',
  'run.failure.noCategories': 'The run stopped: this budget has no category a suggestion could name.',
  'run.failure.notConfigured': 'The run stopped: no Jev API key could be used. Save one to categorize.',
  'run.failure.notConfiguredMember':
    'The run stopped: no Jev API key could be used. The owner of this budget has to save one to categorize.',
  'run.failure.internal': 'The run stopped unexpectedly. Start it again.',
  'run.noKeyMember':
    'No Jev API key can be used: the owner of this budget has to save one, or the shared key has to be on.',
  'run.keyLink': 'Jev API key',
  'run.empty':
    'Nothing to ask about right now: no transaction waiting for a Jev answer, whether it needs a category or looks like a transfer.',
  'run.startFailed': 'Could not start the run.',
  'run.loadFailed': 'Could not read the run status.',

  // Transfers: the matcher's pairs and Jev's "this is a transfer" answers, above
  // the category bundles (Jev's are grouped by the account pair they name).
  'transfer.title': 'TRANSFERS',
  'transfer.jevHeading': 'JEV SAYS TRANSFER',
  'transfer.matcherHeading': 'LOOKS LIKE A TRANSFER',
  'transfer.to': 'Transfer to {account}',
  'transfer.from': 'Transfer from {account}',
  'transfer.pair': '{out} → {in}',
  'transfer.choose': 'Choose match',
  'transfer.count': { one: '{count} transaction', other: '{count} transactions' },
  'transfer.percent': '{percent}%',
  'transfer.accept': 'Accept',
  'transfer.acceptPair': 'Accept all ({count})',
  'transfer.refuse': 'Not a transfer',
  'transfer.skip': 'Skip',
  'transfer.subject': '{payee} · {amount}',
  'transfer.filedTo': 'Transfer · {account}',
  'transfer.refusedToast': 'Marked as not a transfer',
  'transfer.linkedCount': { one: '{count} transfer linked', other: '{count} transfers linked' },
  'transfer.loadFailed': 'Could not read Jev’s transfer suggestions.',
  'transfer.matcherFailed': 'Could not read the transfer pairs found for you.',
  'transfer.refuseFailed': 'Could not record “not a transfer”.',
  'transfer.errorRefused': 'This row was answered “not a transfer”; link it in the register to make it one.',
  'transfer.errorCategorized': 'This row is already categorized, so it is not a transfer any more.',
  'transfer.errorNoCategory': 'This row no longer needs a category: it is a transfer already.',
  /** One by one: the matcher's pairs are not answered there. */
  'transfer.paneNote': {
    one: '{count} pair looks like a transfer: review it in Bundles',
    other: '{count} pairs look like transfers: review them in Bundles',
  },
  'transfer.focusLabel': 'TRANSFER',
  'transfer.focusHint': 'Accepting links both sides and files no category.',
} as const;
