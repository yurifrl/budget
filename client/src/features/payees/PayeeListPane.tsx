import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import type { PayeeAdminRow } from '@/budget/data/rows';
import { colors } from '@/ui/theme';
import { t } from './i18n';
import { transferPayeeLabel } from './renameRules.logic';
import { styles } from './styles';
import type { PayeeAdmin } from './usePayeeAdmin';
import { displaySystemName } from '@/domain/systemNames';

function GroupHeader({ title, open, onToggle }: { title: string; open: boolean; onToggle: () => void }) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={t('list.groupToggle', { group: title })}
      accessibilityState={{ expanded: open }}
      style={styles.groupHeader}>
      <Text style={styles.groupChevron}>{open ? '▾' : '▸'}</Text>
      <Text style={styles.groupTitle}>{title}</Text>
    </Pressable>
  );
}

function PayeeRow({
  payee,
  label,
  hint,
  active,
  onPress,
}: {
  payee: PayeeAdminRow;
  label: string;
  /** Small tag after the name ("Closed"). */
  hint?: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.listRow, active && styles.listRowActive, pressed && { backgroundColor: colors.hover }]}>
      <Text style={[styles.listName, payee.hidden && styles.listNameHidden]} numberOfLines={1}>
        {label}
      </Text>
      {hint ? <Text style={styles.listHint}>{hint}</Text> : null}
      <Text style={styles.listCount}>{payee.transaction_count}</Text>
    </Pressable>
  );
}

/**
 * Left pane: the inline add row and the searchable payee list with usage
 * counts, in two collapsible groups: the payees, and the accounts' transfer
 * payees (open accounts first, closed ones last with a "Closed" tag).
 */
export function PayeeListPane({ admin, fill }: { admin: PayeeAdmin; /** Phone: the list takes the whole width. */ fill?: boolean }) {
  const { newName, setNewName, addNewPayee, busy, groups, closedIds, search, select, selectedId } = admin;
  const [payeesOpen, setPayeesOpen] = useState(true);
  const [transfersOpen, setTransfersOpen] = useState(true);
  const searching = search.trim() !== '';
  // A search shows its matches in both groups, collapsed or not.
  const showPayees = payeesOpen || searching;
  const showTransfers = transfersOpen || searching;
  const none = groups.payees.length === 0 && groups.transfers.length === 0;
  return (
    <ScrollView style={[styles.listPane, fill && { width: '100%', flexGrow: 1 }]} contentContainerStyle={[styles.listContent, fill && styles.phoneBottom]}>
      <View style={styles.addRow}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          onSubmitEditing={addNewPayee}
          placeholder={t('list.addPlaceholder')}
          placeholderTextColor={colors.faint}
          style={styles.addInput}
          accessibilityLabel={t('list.newNameLabel')}
        />
        <Pressable onPress={addNewPayee} accessibilityRole="button" accessibilityLabel={t('list.addLabel')}>
          <Text style={styles.addRowBtn}>＋</Text>
        </Pressable>
      </View>
      {busy ? (
        <Text style={styles.empty}>{tCommon('loading')}</Text>
      ) : none ? (
        <Text style={styles.empty}>{t('list.noMatch', { query: search.trim() })}</Text>
      ) : (
        <>
          {groups.payees.length > 0 || !searching ? (
            <>
              <GroupHeader title={t('list.groupPayees')} open={showPayees} onToggle={() => setPayeesOpen(!payeesOpen)} />
              {showPayees
                ? groups.payees.map((p) => (
                    <PayeeRow key={p.id} payee={p} label={displaySystemName(p.name)} active={p.id === selectedId} onPress={() => select(p)} />
                  ))
                : null}
            </>
          ) : null}
          {groups.transfers.length > 0 ? (
            <>
              <GroupHeader
                title={t('list.groupTransfers', { count: groups.transfers.length })}
                open={showTransfers}
                onToggle={() => setTransfersOpen(!transfersOpen)}
              />
              {showTransfers
                ? groups.transfers.map((p) => (
                    <PayeeRow
                      key={p.id}
                      payee={p}
                      label={transferPayeeLabel(p)}
                      hint={p.transfer_account_id && closedIds.has(p.transfer_account_id) ? t('list.closed') : undefined}
                      active={p.id === selectedId}
                      onPress={() => select(p)}
                    />
                  ))
                : null}
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
