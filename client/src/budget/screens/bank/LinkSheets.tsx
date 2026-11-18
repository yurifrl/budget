/**
 * Bank-page link sheets: choose the budget account for a bank account
 * (shared LinkPicker, budget-account direction) and confirm unlinking one.
 * Both render in an OverlaySheet so they work on phone and desktop widths.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ConnectionUpstreamJson, UpstreamAccountJson } from '../../data/connections';
import type { AccountRow } from '../../data/rows';
import { accountOptionGroups, comparableBankCents, upstreamOptionGroups, workingBalanceCents } from '../../domain/linkPicker';
import { OverlaySheet } from '../../ui/bits';
import { LinkPicker } from './LinkPicker';
import { UnlinkConfirm } from './UnlinkConfirm';
import { useAccountLink } from './useAccountLink';

export function LinkAccountSheet({
  budgetId,
  connectionId,
  institution,
  bank,
  currentAccountId,
  accounts,
  upstream,
  onClose,
}: {
  budgetId: string;
  connectionId: string;
  institution: string | null;
  /** The bank account to link; null = sheet closed. */
  bank: UpstreamAccountJson | null;
  /** Budget account that follows `bank` today (change mode); null = first link. */
  currentAccountId?: string | null;
  accounts: AccountRow[];
  upstream: ConnectionUpstreamJson[];
  onClose: () => void;
}) {
  const { link, move, busy } = useAccountLink(budgetId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [bank]);

  return (
    <OverlaySheet visible={bank != null} onClose={onClose} title={bank ? `Link ${bank.name}` : undefined}>
      {bank ? (
        <View style={styles.pad}>
          <LinkPicker
            key={bank.externalId}
            heading="Choose one budget account"
            helper="A bank account feeds exactly one budget account. Tap an account to select it, then confirm."
            referenceLabel={bank.type === 'CREDIT' ? 'Owed on the card' : 'Bank balance'}
            referenceCents={comparableBankCents(bank)}
            groups={accountOptionGroups(bank, accounts, upstream)}
            loading={false}
            emptyText="No open budget accounts to link."
            busy={busy}
            error={error}
            listMaxHeight={380}
            onCancel={onClose}
            onConfirm={async (accountId) => {
              setError(null);
              const inst = bank.institution ?? institution;
              const failure = currentAccountId
                ? await move(currentAccountId, accountId, connectionId, bank.externalId, inst)
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
    <OverlaySheet visible={visible} onClose={onClose} title={`Link ${account.name}`}>
      <View style={styles.pad}>
        <LinkPicker
          heading="Choose one bank account"
          helper="A budget account follows exactly one bank account. Tap one to select it, then confirm."
          referenceLabel="Your balance in syscd"
          referenceCents={workingBalanceCents(account)}
          groups={upstreamOptionGroups(upstream, account, budgetAccounts)}
          loading={loading}
          loadFailed={loadFailed}
          onRetry={onRetry}
          emptyText="No bank accounts available yet — connect a new bank first."
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
  /** The budget account to unlink; null = sheet closed. */
  account: { id: string; name: string } | null;
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
            const failure = await unlink(account.id);
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
