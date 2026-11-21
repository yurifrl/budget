export default {
  // Row menu actions
  'menu.sync': 'Sync now',
  'menu.reimport': 'Re-import history',
  'menu.reconnect': 'Reconnect credentials',
  'menu.settings': 'Settings',

  // Remove confirmation
  'remove.blockedTitle': 'Can’t remove {institution}',
  'remove.blockedBody': {
    one: 'Unlink the {count} linked account in the account editor first.',
    other: 'Unlink the {count} linked accounts in the account editor first.',
  },
  'remove.confirmTitle': 'Remove {institution}?',
  'remove.confirmBody': 'The bank connection is deleted. Imported history stays in your budget.',

  // Actions (sync / re-import / remove)
  'actions.syncFailed': 'Could not sync the bank',
  'actions.reimportFailed': 'Could not re-import the bank history',
  'actions.removeFailed': 'Could not remove the bank',
  'actions.removed': 'Bank removed — its imported history stays in your budget.',

  // Connect flow
  'flow.titleNew': 'Link bank account',
  'flow.titleReconnect': 'Reconnect bank',
  'flow.finishing': 'Finishing the connection…',
  'flow.opening': 'Opening the connection window…',
  'flow.needsLogin': 'The bank needs its own login window — allow it to open, then try again.',
  'flow.startFailed': 'Could not start the connection flow',
  'flow.refreshFailed': 'Could not refresh the reconnected bank',
  'flow.registerFailed': 'Could not register the connected bank',

  // Banks list and rows
  'list.none': 'No banks linked yet. Connect one to pull accounts and transactions.',
  'list.summary': { one: '{count} bank · {connected} connected', other: '{count} banks · {connected} connected' },
  'row.reauthAdded': 'Reconnect to refresh credentials · added {stamp}',
  'row.reauthSandbox': 'Reconnect to refresh credentials · sandbox',
  'row.lastSync': 'Last sync: {stamp}',
  'row.lastSyncSandbox': 'Last sync: {stamp} · sandbox',
  'row.lastAdded': 'Last sync: added {stamp}',
  'row.lastAddedSandbox': 'Last sync: added {stamp} · sandbox',
  'row.openA11y': 'Open {name}',
  'row.syncA11y': 'Sync {institution}',
  'row.editA11y': 'Edit {institution}',

  // Upstream accounts list
  'upstream.unavailable': 'Accounts unavailable — Sync now to refresh.',
  'upstream.none': 'No accounts returned by this bank.',
  'upstream.type.credit': 'credit',
  'upstream.type.bank': 'bank',
  'upstream.notLinked': 'not linked',

  // Sync window control
  'window.default': 'Default ({label})',
  'window.defaultA11y': 'Sync history default',
  'window.presetA11y': 'Sync history {label}',
  'window.daysPlaceholder': 'days',
  'window.set': 'Set',
  'window.setA11y': 'Apply custom sync window',
  'window.cancelA11y': 'Cancel custom sync window',
  'window.customDays': '{days}d',
  'window.other': 'Other…',
  'window.customA11y': 'Custom sync window',
} as const;
