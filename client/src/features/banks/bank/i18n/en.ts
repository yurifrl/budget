export default {
  // Overview tab
  'overview.stat.linked': 'Linked accounts',
  'overview.stat.imported': 'Imported',
  'overview.stat.edited': 'Edited by you',
  'overview.stat.removed': 'Removed at bank',
  'overview.stat.total': 'Total rows',
  'overview.accounts': 'Accounts',
  'overview.notLinked': 'Not linked',
  'overview.empty': 'No budget account is linked to this bank yet. Use “Link to a budget account” on a bank account below.',
  'overview.unlinked.credit': 'Credit account · not linked to a budget account',
  'overview.unlinked.bank': 'Bank account · not linked to a budget account',
  'overview.linkButton': 'Link to a budget account',
  'overview.linkA11y': 'Link {name} to a budget account',
  'overview.noTransactions': 'No transactions yet',
  'overview.openA11y': 'Open {name}',
  'overview.account.credit': 'Credit account → {name}',
  'overview.account.bank': 'Bank account → {name}',
  'overview.linkedTo': 'Linked to {name}',
  'overview.change': 'Change',
  'overview.changeA11y': 'Change link for {name}',
  'overview.unlinkA11y': 'Unlink {name}',

  // Link option card
  'card.currentBill': 'Current bill',
  'card.dueDate': 'Due date',
  'card.limitUsed': 'Limit used',
  'card.limit': 'Limit',
  'card.linkedTo': 'Linked to {name}',
  'card.matches': 'Matches your balance',
  'card.different': '{amount} different',

  // Link picker
  'picker.loadFailed': 'Could not load your bank accounts — the bank did not answer.',
  'picker.retryA11y': 'Retry loading bank accounts',
  'picker.linking': 'Linking…',
  'picker.linkTo': 'Link to {title}',
  'picker.selectOne': 'Select one to link',

  // Link sheets
  'sheet.linkTitle': 'Link {name}',
  'sheet.account.heading': 'Choose one budget account',
  'sheet.account.helper': 'A bank account feeds exactly one budget account. Tap an account to select it, then confirm.',
  'sheet.account.owed': 'Owed on the card',
  'sheet.account.bankBalance': 'Bank balance',
  'sheet.account.empty': 'No open budget accounts to link.',
  'sheet.bank.heading': 'Choose one bank account',
  'sheet.bank.helper': 'A budget account follows exactly one bank account. Tap one to select it, then confirm.',
  'sheet.bank.reference': 'Your balance in syscd',
  'sheet.bank.empty': 'No bank accounts available yet — connect a new bank first.',

  // Link / unlink actions
  'link.failed': 'Could not link the account',
  'link.unlinkFailed': 'Could not unlink the account',
  'link.restoreFailed': '{failure} (and the previous link could not be restored: {restored})',

  // Unlink confirmation
  'unlink.title': 'Unlink bank account?',
  'unlink.body': '{name} will stop syncing with the bank. Transactions already imported stay in your budget; no new ones arrive until you link again.',
  'unlink.busy': 'Unlinking…',
  'unlink.button': 'Unlink',

  // Bank balance card
  'balance.title': 'BANK BALANCE',
  'balance.matches': 'Matches budget',
  'balance.differs': 'Budget differs by {amount}',
  'balance.in': '↑ {amount} in',
  'balance.out': '↓ {amount} out',
  'balance.last30': 'last 30 days',

  // Credit bill card
  'bill.current': 'CURRENT BILL',
  'bill.title': 'BILL',
  'bill.due': 'Due {date}',
  'bill.usedPct': 'used · {pct}%',
  'bill.used': 'used',
  'bill.of': 'of {amount}',
  'bill.available': '{amount} available',
  'bill.limit': 'Limit {amount}',

  // Account tab
  'account.loadFailed': 'Could not load this account’s transactions.',
  'account.empty': 'No imported transactions for this account yet. Sync the bank to pull them.',
  'account.col.date': 'DATE',
  'account.col.payee': 'PAYEE',
  'account.col.memo': 'MEMO',
  'account.col.state': 'STATE',
  'account.col.amount': 'AMOUNT',
  'account.col.cleared': 'C',
  'account.noPayee': '(no payee)',
  'account.loadMore': 'Load more',
  'account.end': { one: '{count} transaction · end of history', other: '{count} transactions · end of history' },

  // Settings panel
  'settings.history.title': 'Sync history',
  'settings.history.hint': 'How far back this bank’s pulls reach. Default follows the app-wide setting.',
  'settings.reimport': 'Re-import history',
  'settings.credentials.title': 'Credentials',
  'settings.credentials.hint': 'The bank needs fresh credentials before it can sync again.',
  'settings.reconnect': 'Reconnect',
  'settings.danger.title': 'Danger zone',
  'settings.danger.hint': 'Removes the bank connection. Imported history stays in your budget.',
  'settings.remove': 'Remove bank',
  'settings.unlinkFirst': 'Unlink its accounts in the account editor first.',
} as const;
