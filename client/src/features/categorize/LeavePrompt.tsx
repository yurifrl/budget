/**
 * The question asked when the Categorize page goes away (in-app navigation, a
 * budget switch) with rows still in its "Leaving uncategorized" strip. It lives
 * in the shell, which outlives the page: Send and leave, Keep them and leave
 * (they are not sent and come back next visit), or Stay (back to the page, rows
 * in the strip again). Closing or reloading the tab never reaches this prompt:
 * nothing is sent then, and the strip says so.
 */

import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { budgetApi } from '@/budget/data/api';
import { useAppDispatch, useAppSelector } from '@/state/hooks';
import { switchBudget } from '@/state/thunks';
import { selectActiveBudgetId } from '@/state/ui';
import { GhostButton, IndigoButton, OverlaySheet } from '@/ui/bits';
import { colors } from '@/ui/theme';

import { t } from './i18n';
import { sendEntries } from './leave.logic';
import { leaveStore, onCategorizeRoute } from './leave.store';

export function CategorizeLeavePrompt() {
  const { held } = useSyncExternalStore(leaveStore.subscribe, leaveStore.getState, leaveStore.getState);
  const dispatch = useAppDispatch();
  const router = useRouter();
  const activeBudgetId = useAppSelector(selectActiveBudgetId);
  const pathname = usePathname();
  const [sending, setSending] = useState(false);
  const [failedCount, setFailedCount] = useState(0);

  const count = held?.entries.length ?? 0;

  // The route or the active budget moved away from the page the rows were taken on.
  useEffect(() => {
    leaveStore.holdIfLeft({ onCategorize: onCategorizeRoute(pathname), activeBudgetId });
  }, [pathname, activeBudgetId]);

  const sendAndLeave = async () => {
    if (!held || sending) return;
    setSending(true);
    const { sent, failed } = await sendEntries(held.entries, (transactionId) =>
      dispatch(budgetApi.endpoints.skipCategorize.initiate({ budgetId: held.budgetId, transactionId })).unwrap(),
    );
    setSending(false);
    setFailedCount(failed.length);
    // What was sent leaves the prompt and the page's strip; what could not be sent stays for another try.
    leaveStore.settle('sent', sent.map((entry) => entry.item.transactionId));
  };

  const keepAndLeave = () => {
    setFailedCount(0);
    if (held) leaveStore.settle('discard', held.entries.map((entry) => entry.item.transactionId));
  };

  const stay = () => {
    setFailedCount(0);
    const stayed = leaveStore.stay();
    if (!stayed) return;
    if (stayed.budgetId !== activeBudgetId) void dispatch(switchBudget(stayed.budgetId));
    // Back to the page (a stacked screen on top of it just closes; another tab brings it forward).
    router.navigate('/categorize');
  };

  return (
    <OverlaySheet visible={held !== null} onClose={stay}>
      <Text style={styles.title}>{t('leave.title')}</Text>
      <Text style={styles.body}>{t('leave.body', { count })}</Text>
      {failedCount > 0 ? <Text style={styles.error}>{t('leave.sendFailed', { count: failedCount })}</Text> : null}
      <View style={styles.actions}>
        <GhostButton label={t('leave.stay')} onPress={stay} />
        <GhostButton label={t('leave.keep')} onPress={keepAndLeave} />
        <IndigoButton label={t('leave.send')} onPress={() => void sendAndLeave()} disabled={sending} />
      </View>
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 17, fontWeight: '800', paddingHorizontal: 10, paddingTop: 10 },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 10, paddingVertical: 6 },
  error: { color: colors.redFg, fontSize: 12.5, paddingHorizontal: 10, paddingBottom: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10, padding: 10 },
});
