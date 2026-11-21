/**
 * Bank-page link sheets: choose the budget account for a bank account
 * (shared LinkPicker, budget-account direction) and confirm unlinking one.
 * Both render in an OverlaySheet so they work on phone and desktop widths.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ConnectionUpstreamJson, UpstreamAccountJson } from '@/budget/data/connections';
import type { AccountRow } from '@/budget/data/rows';
import { accountOptionGroups, comparableBankCents, upstreamOptionGroups, workingBalanceCents } from '../model/linkPicker';
import { OverlaySheet } from '@/ui/bits';
import { t } from './i18n';
import { LinkPicker } from './LinkPicker';
import { UnlinkConfirm } from './UnlinkConfirm';
import { useAccountLink } from './useAccountLink';

export function LinkAccountSheet({
  budgetId,
  connectionId,
  institution,
  bank,
  current,
  accounts,
  upstream,
  onClose,
}: {
  budgetId: string;
  connectionId: string;
  institution: string | null;
  /** The bank account to link; null = sheet closed. */
  bank: UpstreamAccountJson | null;
  /**
   * Budget account that follows `bank` today (change mode) with the budget it
   * lives in, which may not be the active one; null = first link.
   */
  current?: { accountId: string; budgetId: string } | null;
  accounts: AccountRow[];
  upstream: ConnectionUpstreamJson[];
  onClose: () => void;
}) {
  const { link, move, busy } = useAccountLink(budgetId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [bank]);

  return (
    <OverlaySheet visible={bank != null} onClose={onClose} title={bank ? t('sheet.linkTitle', { name: bank.name }) : undefined}>
      {bank ? (
        <View style={styles.pad}>
          <LinkPicker
            key={bank.externalId}
            heading={t('sheet.account.heading')}
            helper={t('sheet.account.helper')}
            referenceLabel={bank.type === 'CREDIT' ? t('sheet.account.owed') : t('sheet.account.bankBalance')}
            referenceCents={comparableBankCents(bank)}
            groups={accountOptionGroups(bank, accounts, upstream)}
            loading={false}
            emptyText={t('sheet.account.empty')}
            busy={busy}
            error={error}
            listMaxHeight={380}
            onCancel={onClose}
            onConfirm={async (accountId) => {
              setError(null);
              const inst = bank.institution ?? institution;
              const failure = current
                ? await move(current.accountId, accountId, connectionId, bank.externalId, inst, current.budgetId)
                : await link(accountId, connectionId, bank.externalId, inst);
              if (failure) setError(failure);
              else onClose();
            }}
          />
        </View>
      ) : null}
    </OverlaySheet>
  );
}

/** Sub-modal of Edit Account: choose the bank account a budget account follows. */
export function UpstreamPickerSheet({
  budgetId,
  account,
  budgetAccounts,
  upstream,
  loading,
  loadFailed,
  onRetry,
  visible,
  onClose,
}: {
  budgetId: string;
  account: AccountRow;
  budgetAccounts: AccountRow[];
  upstream: ConnectionUpstreamJson[];
  loading: boolean;
  loadFailed: boolean;
  onRetry: () => void;
  visible: boolean;
  onClose: () => void;
}) {
  const { link, busy } = useAccountLink(budgetId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [visible]);

  return (
    <OverlaySheet visible={visible} onClose={onClose} title={t('sheet.linkTitle', { name: account.name })}>
      <View style={styles.pad}>
        <LinkPicker
          heading={t('sheet.bank.heading')}
          helper={t('sheet.bank.helper')}
          referenceLabel={t('sheet.bank.reference')}
          referenceCents={workingBalanceCents(account)}
          groups={upstreamOptionGroups(upstream, account, budgetAccounts)}
          loading={loading}
          loadFailed={loadFailed}
          onRetry={onRetry}
          emptyText={t('sheet.bank.empty')}
          busy={busy}
          error={error}
          listMaxHeight={380}
          onCancel={onClose}
          onConfirm={async (optionId) => {
            const [connectionId, ...rest] = optionId.split(':');
            const externalId = rest.join(':');
            const entry = upstream.find((e) => e.connection.id === connectionId);
            const acct = entry?.accounts?.find((a) => a.externalId === externalId);
            if (!entry || !acct) return;
            setError(null);
            const failure = await link(
              account.id,
              entry.connection.id,
              acct.externalId,
              acct.institution ?? entry.connection.institution,
            );
            if (failure) setError(failure);
            else onClose();
          }}
        />
      </View>
    </OverlaySheet>
  );
}

export function UnlinkAccountSheet({
  budgetId,
  account,
  onClose,
}: {
  budgetId: string;
  /** The budget account to unlink (and the budget it lives in); null = sheet closed. */
  account: { id: string; name: string; budgetId: string } | null;
  onClose: () => void;
}) {
  const { unlink, busy } = useAccountLink(budgetId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [account]);

  return (
    <OverlaySheet visible={account != null} onClose={onClose}>
      {account ? (
        <UnlinkConfirm
          accountName={account.name}
          busy={busy}
          error={error}
          onCancel={onClose}
          onConfirm={async () => {
            const failure = await unlink(account.id, account.budgetId);
            if (failure) setError(failure);
            else onClose();
          }}
        />
      ) : null}
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 4 },
});
