export default {
  'system.startingBalance': 'Starting Balance',
  'system.reconciliationAdjustment': 'Reconciliation Adjustment',
  'system.creditCardPayments': 'Credit Card Payments',
  'system.transfer': 'Transfer : {account}',

  'account.nicknameRequired': 'nickname is required',

  'repeat.weekly': 'Every week',
  'repeat.everyOtherWeek': 'Every other week',
  'repeat.monthly': 'Monthly',
  'repeat.everyOtherMonth': 'Every other month',
  'repeat.quarterly': 'Quarterly',
  'repeat.yearly': 'Yearly',

  'split.totalOut': '{amount} out',
  'split.totalIn': '{amount} in',
  'split.noAmount': 'no amount',

  'inline.amountRequired': 'enter an amount',
  'inline.dateInvalid': 'invalid date — try {format} or 5, 5/9',
  'inline.splitCategoryRequired': 'every split needs a category',
  'inline.splitAmountRequired': 'enter an amount on each split',
  'inline.rateFetching': 'fetching the USD→BRL rate — try again in a moment',
  'inline.rateMissing': 'no exchange rate available — enter the amount in R$ (without $)',

  'overspend.underfundedLabel': 'Underfunded {amount}',
  'overspend.underfundedDetail': "{amount} more is needed to cover this card's debt",
  'overspend.creditLabel': '{amount} on credit',
  'overspend.creditDetail': '{amount} spent on credit with no money assigned: added to card debt',

  'drop.addTo': 'Add to {name}',
  'drop.bundleWith': 'Bundle with {name}',

  'register.readyToAssign': 'Ready to Assign',
  'register.split': 'Split ({count})',
  'register.transfer': 'Transfer',
  'register.needsCategory': 'needs category',

  'flag.red': 'Red',
  'flag.orange': 'Orange',
  'flag.yellow': 'Yellow',
  'flag.green': 'Green',
  'flag.blue': 'Blue',
  'flag.purple': 'Purple',

  'target.perWeek': 'per week',
  'target.perMonth': 'per month',
  'target.byDate': 'by {date}',

  'people.shared': 'Shared',
  'people.unnamed': 'Unnamed',
  'people.formerMember': 'Former member',
  'people.sharedAccounts': 'Shared accounts',
  'people.accountsOf': '{name}’s accounts',
  'people.sharedCategories': 'Shared categories',
  'people.categoriesOf': '{name}’s categories',
  'invite.nameTooLong': 'Name must be {max} characters or fewer',
  'invite.nameRequired': 'Enter a name (or an email address)',
  'invite.emailInvalid': 'That doesn’t look like an email address',
  'invite.alreadyMember': '{name} is already in this budget',
  'invite.emailRequired': 'Enter an email address',
} as const;
