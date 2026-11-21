export default {
  // Bank link hints and label (accountEdit.logic.ts)
  'link.unavailable': 'Bank account list unavailable — Sync now to refresh.',
  'link.stale': 'This link no longer matches a bank account — change the link to pick a new one.',
  'link.connectedTo': 'Connected to {institution}',
  'link.bankFallback': 'bank',

  // Delete Account confirm
  'delete.title': 'Delete Account',
  'delete.body':
    "Permanently delete <b>{accountName}</b> and every transaction it ever held? The account's balance will be removed from your plan. This cannot be undone.",
  'delete.deleting': 'Deleting…',

  // Close Account confirm
  'close.title': 'Close Account',
  'close.plain': 'Are you sure you want to close this account?',
  'close.confirm': 'Close',
  'close.adjustBody':
    'Before you can close this account, the balance will have to be zeroed out. An adjustment transaction will be created for <b>{amount}</b>.',
  'close.leavesPlan':
    'The money in this account will be removed from your plan. If you would like to keep it in your plan, you can transfer it to another account before closing this one.',
  'close.adjustConfirm': 'Adjust Balance & Close',

  // Bank connection section
  'connection.following': 'FOLLOWING',
  'connection.syncNow': 'Sync now',
  'connection.syncing': 'Syncing…',
  'connection.reconnect': 'Reconnect',
  'connection.manage': 'Manage on bank page',
  'connection.changeLink': 'Change link',
  'connection.unlink': 'Unlink',
  'connection.notLinked': 'Not linked to a bank. Connect one to import transactions and update the balance automatically.',
  'connection.chooseAccount': 'Choose bank account',
  'connection.connectNew': 'Connect a new bank',

  // Fallbacks for failed requests
  'error.sync': 'Could not sync the bank connection',
  'error.update': 'Could not update the account',
  'error.close': 'Could not close the account',
  'error.delete': 'Could not delete the account',
} as const;
