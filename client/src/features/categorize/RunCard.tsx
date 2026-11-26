/**
 * The Categorize run card: the Run button with its confirmation, live progress
 * and the failures summary. When no Jev key can be used it says so and links
 * to the key screen; with nothing waiting it says the queue is empty.
 */

import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { GhostButton, IndigoButton } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import { t } from './i18n';
import {
  runFailureLabel,
  runFailureNeedsKey,
  runFailuresLabel,
  runHeadline,
  runKeyProblemLabel,
  runOffersKeyLink,
  runProgressLabel,
  runRestLabel,
  runSendCount,
  runStartErrorMessage,
} from './run.logic';
import type { CategorizeRunState } from './useCategorizeRun';

export function RunCard({ run, isOwner }: { run: CategorizeRunState; isOwner: boolean }) {
  const router = useRouter();
  const problem = run.status?.reason ?? null;
  const inFlight = run.phase === 'waiting' || run.phase === 'running';
  const sendable = runSendCount(run.status);
  const empty = !problem && sendable === 0;
  const progress = runProgressLabel(run.status);
  const failure = runFailureLabel(run.status, { isOwner });
  const failures = runFailuresLabel(run.status);
  const failedOnKey = runFailureNeedsKey(run.status);

  return (
    <View style={styles.card}>
      <View style={styles.body}>
        <Text style={styles.label}>{t('run.title')}</Text>

        {run.isError ? (
          <Text style={styles.error}>{t('run.loadFailed')}</Text>
        ) : problem ? (
          <Text style={styles.problem}>{runKeyProblemLabel(problem, { isOwner })}</Text>
        ) : empty && run.phase === 'never' ? (
          <Text style={styles.state}>{t('run.empty')}</Text>
        ) : (
          <Text style={styles.state}>{runHeadline(run.status)}</Text>
        )}

        {progress ? <Text style={styles.meta}>{progress}</Text> : null}
        {failures ? <Text style={styles.meta}>{failures}</Text> : null}
        {failure ? <Text style={styles.error}>{failure}</Text> : null}
        {failedOnKey && !problem && isOwner ? (
          <GhostButton label={t('run.keyLink')} onPress={() => router.push('/jev-key')} />
        ) : null}
        {run.startError ? (
          <Text style={styles.error}>{runStartErrorMessage(run.startError, { isOwner })}</Text>
        ) : null}

        {run.confirming ? (
          <View style={styles.confirm}>
            <Text style={styles.label}>{t('run.confirmTitle')}</Text>
            <Text style={styles.confirmBody}>
              {t('run.confirmBody', { count: sendable })}
            </Text>
            {runRestLabel(run.status) ? <Text style={styles.hint}>{runRestLabel(run.status)}</Text> : null}
            <View style={styles.actions}>
              <GhostButton label={tCommon('cancel')} onPress={run.cancelAsk} />
              <IndigoButton
                label={t('run.confirmStart')}
                disabled={run.starting}
                onPress={run.start}
              />
            </View>
          </View>
        ) : null}
      </View>

      <View style={styles.side}>
        {problem && runOffersKeyLink(problem, { isOwner }) ? (
          <GhostButton label={t('run.keyLink')} onPress={() => router.push('/jev-key')} />
        ) : null}
        {run.isError ? <GhostButton label={tCommon('retry')} onPress={run.retry} /> : null}
        {!run.isError && !problem && !empty && !run.confirming ? (
          <IndigoButton
            label={t('run.button')}
            disabled={inFlight || run.starting || run.isLoading || sendable === 0}
            onPress={run.ask}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 13,
    paddingHorizontal: 18,
  },
  body: { flexBasis: 320, flexGrow: 1, minWidth: 240, gap: 4 },
  side: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  state: { color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 12 },
  problem: { color: colors.text, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  error: { color: colors.red, fontSize: 12 },
  confirm: { gap: 8, paddingTop: 6 },
  confirmBody: { color: colors.text, fontSize: 13, lineHeight: 19 },
  hint: { color: colors.faint, fontSize: 11, lineHeight: 16 },
  actions: { flexDirection: 'row', gap: 8 },
});
