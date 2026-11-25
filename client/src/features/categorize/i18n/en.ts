export default {
  // CategorizeScreen (placeholder in checkpoint 1; the page lands next)
  'screen.title': 'Categorize',

  // Header subtitle: the queue size and how many rows already have a suggestion
  'queue.subtitle': {
    one: '{count} uncategorized transaction · suggestions ready for {ready}',
    other: '{count} uncategorized transactions · suggestions ready for {ready}',
  },

  // Bundle card date range (both dates go through formatDate first)
  'bundle.dateRange': '{first} – {last}',

  // Why a row is in the "No suggestion" group (a hidden best guess is not on the wire)
  'manual.belowThreshold': 'below the threshold',
  'manual.noSuggestion': 'no suggestion',
  'manual.failed': 'classification failed',
  'manual.notClassified': 'not classified',

  // Merchant panel: only the facts the bank sent are shown (never a map)
  'merchant.name': 'Merchant',
  'merchant.legalName': 'Legal name',
  'merchant.cnpj': 'CNPJ',
  'merchant.businessCategory': "Bank's category",
  'merchant.operationType': 'Operation type',
  'merchant.counterparty': 'PIX counterparty',

  // Undo toast
  'toast.filed': '{subject} → {category}',
  'toast.filedCount': { one: '{count} transaction filed', other: '{count} transactions filed' },
} as const;
