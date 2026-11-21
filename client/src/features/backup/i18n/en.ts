export default {
  'screen.needBudget': 'Activate a budget to export or restore it.',

  'export.title': 'Export',
  'export.hint':
    'Saves the whole budget — category plan and transaction register — as a zip archive with two TSV tables, shareable from this device.',
  'export.button': 'Export backup',
  'export.preparing': 'Preparing…',
  'export.failed': 'Could not export the backup.',

  'import.title': 'Import',
  'import.ownerOnly': 'Only the owner of this budget can restore a backup into it.',
  'import.hint':
    'Restores backup tables into this budget. Choose the Plan file, the Register file or both, then pick which parts to restore: the plan (categories, assignments) and/or the register (accounts, transactions). Whatever you restore replaces what is currently in the budget.',
  'import.choosePlan': 'Choose Plan file…',
  'import.chooseRegister': 'Choose Register file…',
  'import.chooseAgain': 'Choose again…',
  'import.reading': 'Reading…',
  'import.noFile': 'No file chosen',
  'import.wrongTable': '{file}: not the {table} table — expected a file whose name ends in “{suffix}”',
  'import.unreadable': 'This is not a readable backup.',
  'import.readFailed': 'Could not read the file.',
  'import.restoreFailed': 'Could not restore the backup.',

  'restored.summary': 'Restored {counts}.',
  'restored.nothing': 'Restored nothing.',
  'restored.uncategorized': {
    one: '{count} transaction had no matching category and stayed uncategorized.',
    other: '{count} transactions had no matching category and stayed uncategorized.',
  },

  'section.plan': 'Plan',
  'section.register': 'Register',
  'scope.title': 'This backup contains',
  'scope.missing': 'Not in the chosen files',
  'scope.chooseNone': 'Choose what to restore',
  'scope.restore': 'Restore selected…',
  'scope.sectionCounts': '{section}: {counts}',

  'count.group': { one: '{count} group', other: '{count} groups' },
  'count.category': { one: '{count} category', other: '{count} categories' },
  'count.account': { one: '{count} account', other: '{count} accounts' },
  'count.transaction': { one: '{count} transaction', other: '{count} transactions' },
  'count.assignment': { one: '{count} assignment', other: '{count} assignments' },

  'confirm.title': 'Restore this backup?',
  'confirm.replaceAll':
    'This replaces everything currently in “{name}” (categories, accounts, payees, transactions and assignments) with:',
  'confirm.replacePlan': 'This replaces the categories, groups and assignments of “{name}” with:',
  'confirm.replaceRegister': 'This replaces the accounts, payees and transactions of “{name}” with:',
  'confirm.noteWithPlan':
    'Your existing accounts and transactions stay. Their categories are re-linked to the restored categories by group and name; transactions whose category is not in the backup become uncategorized.',
  'confirm.noteWithRegister':
    'Your existing categories and assignments stay. Transaction categories are matched to them by group and name; transactions whose category is not found become uncategorized.',
  'confirm.unmatched': {
    one: '{count} transaction names a category this budget does not have and will be uncategorized.',
    other: '{count} transactions name a category this budget does not have and will be uncategorized.',
  },
  'confirm.replace': 'Replace',
  'confirm.restoring': 'Restoring…',

  'transfer.notUtf8': '{file}: not valid UTF-8',
  'transfer.notZip': '{file}: not a readable zip archive',
  'transfer.noTable': 'a Plan.tsv or Register.tsv file is required',
  'transfer.needCategories': 'Register.tsv alone needs the budget categories to match against',
  'transfer.planHeader': 'Plan.tsv: unexpected header row',
  'transfer.registerHeader': 'Register.tsv: unexpected header row',
  'transfer.badMonth': 'Plan.tsv: unparseable month cell {cell}',
  'transfer.noCategory': 'Plan.tsv: row without category {row}',
  'transfer.badDate': 'Register.tsv: unparseable date cell {cell}',
  'transfer.unknownCleared': 'Register.tsv: unknown Cleared cell {cell} -> uncleared',
  'transfer.unknownCategories': 'Register.tsv: unknown categories: {list}',
  'transfer.missingCategories': 'Register.tsv: categories not in this budget (rows stay uncategorized): {list}',
  'transfer.unknownAccount': 'Register.tsv: transfer payee names unknown account {account}',
  'transfer.unpairedTransfer': 'Register.tsv: unpaired transfer transaction {payee}',
  'transfer.notMember': '{file}: {email} is not a member of this budget -> Shared',
} as const;
