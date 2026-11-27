/**
 * The Categorize run card: the Run button with its confirmation, live progress
 * and the failures summary. When no Jev key can be used it says so and links
 * to the key screen; with nothing waiting it says the queue is empty.
 */

import { useRouter } from 'expo-router';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { GhostButton, IndigoButton } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import { t } from './i18n';
import {
  runFailureLabel,
  runFailureNeedsKey,
  runFailuresLabel,
  runHeadline,
  runHourlyHint,
  runKeyProblemLabel,
  runOffersKeyLink,
  runProgressLabel,
  runSendCount,
  runStartErrorMessage,
} from './run.logic';
import type { CategorizeRunState } from './useCategorizeRun';

export function RunCard({ run, isOwner }: { run: CategorizeRunState; isOwner: boolean }) {
  const router = useRouter();
  const problem = run.status?.reason ?? null;
  const inFlight = run.phase === 'waiting' || run.phase === 'running';
  const waiting = run.status?.waiting ?? 0;
  const sendable = runSendCount(run.status, run.countChoice);
  const empty = !problem && waiting === 0;
  const hint = runHourlyHint(run.status, run.countChoice);
  // A count that is not a size has no question to answer: the cue says why,
  // and "Ask Jev about 0 transactions?" never appears.
  const sized = run.countField.kind !== 'invalid';
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
        {!run.confirming && hint ? <Text style={styles.hint}>{hint}</Text> : null}
        {failedOnKey && !problem && isOwner ? (
          <GhostButton label={t('run.keyLink')} onPress={() => router.push('/jev-key')} />
        ) : null}
        {run.startError ? (
          <Text style={styles.error}>{runStartErrorMessage(run.startError, { isOwner })}</Text>
        ) : null}

        {run.confirming ? (
          <View style={styles.confirm}>
            <Text style={styles.label}>{t('run.confirmTitle')}</Text>
            {run.checking ? (
              <Text style={styles.state}>{t('run.checking')}</Text>
            ) : sized && sendable > 0 ? (
              <Text style={styles.confirmBody}>{t('run.confirmBody', { count: sendable })}</Text>
            ) : null}
            <Text style={styles.label}>{t('run.countLabel')}</Text>
            <TextInput
              style={styles.countInput}
              value={run.countText}
              onChangeText={run.setCountText}
              placeholder={run.checking ? t('run.countLabel') : t('run.countAll', { count: sendable })}
              keyboardType="number-pad"
              inputMode="numeric"
              accessibilityLabel={t('run.countLabel')}
            />
            {run.countCue ? <Text style={styles.cue}>{run.countCue}</Text> : null}
            {!run.checking && hint ? <Text style={styles.hint}>{hint}</Text> : null}
            <View style={styles.actions}>
              <GhostButton label={tCommon('cancel')} onPress={run.cancelAsk} />
              <IndigoButton
                label={t('run.confirmStart')}
                disabled={
                  run.starting || run.checking || !sized || sendable === 0
                }
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
  /** flexShrink keeps the column inside the card at phone width (RN defaults to 0). */
  body: { flexBasis: 320, flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 4 },
  side: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  state: { color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 12 },
  problem: { color: colors.text, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  error: { color: colors.red, fontSize: 12 },
  confirm: { gap: 8, paddingTop: 6, minWidth: 0 },
  confirmBody: { color: colors.text, fontSize: 13, lineHeight: 19 },
  countInput: {
    width: '100%',
    minWidth: 0,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 12,
    color: colors.text,
    fontSize: 13,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { color: colors.faint, fontSize: 11, lineHeight: 16 },
  cue: { color: colors.yellowPillFg, fontSize: 11, lineHeight: 16 },
});
