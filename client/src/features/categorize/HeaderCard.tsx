/**
 * The page header card (mock ev-2d6f08): confidence threshold on the left,
 * the classification run in the middle, the queue count on the right. The
 * threshold commits on release (one settings write per gesture); the run block
 * renders the status view computed by `runHeaderView`.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { IndigoButton, FundingBar } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import { t } from './i18n';
import { thresholdFromX, thresholdPercent, thresholdLabel, type RunHeaderView } from './page.logic';

export function HeaderCard({
  threshold,
  onThreshold,
  thresholdDisabled,
  run,
  aiAvailable,
  runStarting,
  onRun,
  left,
}: {
  threshold: number;
  onThreshold: (value: number) => void;
  thresholdDisabled?: boolean;
  /** Null while the run status is still loading. */
  run: RunHeaderView | null;
  aiAvailable: boolean;
  runStarting: boolean;
  onRun: () => void;
  left: number | undefined;
}) {
  const { width } = useWindowDimensions();
  const wide = width > 980;
  const running = run?.kind === 'active';
  const disabled = thresholdDisabled || !aiAvailable || runStarting || running;
  return (
    <View style={styles.card}>
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('header.threshold')}</Text>
        <View style={styles.thresholdRow}>
          <ThresholdSlider value={threshold} onChange={onThreshold} disabled={thresholdDisabled} />
          <Text style={styles.percent}>{thresholdLabel(threshold)}</Text>
        </View>
        <Text style={styles.hint}>{t('header.thresholdHint', { percent: thresholdPercent(threshold) })}</Text>
      </View>

      <View style={[styles.section, styles.middle, wide && styles.divided]}>
        <View style={styles.runRow}>
          <View style={[styles.dot, { backgroundColor: aiAvailable ? colors.green : colors.faint }]} />
          <View style={styles.runText}>
            <Text style={styles.runTitle}>{run?.title ?? tCommon('loading')}</Text>
            {run?.detail ? (
              <Text style={styles.runDetail} numberOfLines={2}>
                {run.detail}
              </Text>
            ) : null}
          </View>
          <IndigoButton
            label={running ? t('header.running') : t('header.run')}
            onPress={onRun}
            disabled={disabled}
          />
        </View>
        {running ? (
          <View
            accessibilityLabel={t('header.progressLabel')}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: Math.round((run?.fraction ?? 0) * 100) }}>
            <FundingBar state="green" fraction={run?.fraction ?? 0} />
          </View>
        ) : null}
      </View>

      <View style={[styles.section, styles.countSection, wide && styles.divided]}>
        <Text style={styles.count}>{left ?? '—'}</Text>
        <Text style={styles.countLabel}>{t('header.left')}</Text>
      </View>
    </View>
  );
}

function ThresholdSlider({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const percent = thresholdPercent(shown);
  const from = (x: number) => thresholdFromX(x, width);
  return (
    <View
      style={styles.sliderTouch}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderGrant={(e) => setDraft(from(e.nativeEvent.locationX))}
      onResponderMove={(e) => setDraft(from(e.nativeEvent.locationX))}
      onResponderRelease={(e) => {
        const next = from(e.nativeEvent.locationX);
        setDraft(null);
        onChange(next);
      }}
      accessibilityRole="adjustable"
      accessibilityLabel={t('header.thresholdLabel')}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (disabled) return;
        const step = e.nativeEvent.actionName === 'increment' ? 0.05 : -0.05;
        onChange(Math.round(Math.max(0, Math.min(1, value + step)) * 100) / 100);
      }}>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
      <Pressable style={[styles.knob, { left: `${percent}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
  },
  section: { flexBasis: 280, flexGrow: 1, minWidth: 240, paddingVertical: 15, paddingHorizontal: 18, gap: 7 },
  middle: { gap: 10 },
  divided: { borderLeftWidth: 1, borderLeftColor: colors.border },
  sectionLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  thresholdRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  sliderTouch: { flex: 1, height: 26, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.border2, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.indigo2 },
  knob: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.indigo3,
    borderWidth: 2,
    borderColor: colors.card,
    transform: [{ translateX: -7 }],
  },
  percent: { color: colors.text, fontSize: 15, fontWeight: '700', minWidth: 44, textAlign: 'right' },
  hint: { color: colors.faint, fontSize: 11, lineHeight: 16 },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 2 },
  runText: { flex: 1, minWidth: 0, gap: 2 },
  runTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  runDetail: { color: colors.muted, fontSize: 11, lineHeight: 15 },
  countSection: { flexBasis: 170, flexGrow: 0, alignItems: 'flex-end', justifyContent: 'center', gap: 0 },
  count: { color: colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  countLabel: { color: colors.muted, fontSize: 11 },
});
