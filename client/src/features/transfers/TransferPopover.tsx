/**
 * "Looks like a transfer" popover (mock ①): both sides, why, the "Always
 * treat <payee> as a transfer" checkbox, and Not a transfer / Other account… /
 * Link as transfer. Anchored under the ⇄ at desktop width, a bottom sheet on
 * phones. "Other account…" swaps the body for the account picker (another
 * account of the budget, or an account outside it).
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { TransferSuggestion } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import type { Account } from '@/domain/types';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';
import { t } from './i18n';
import { SelectionCheckbox } from '@/ui/SelectionCheckbox';
import { popoverSides, transferTargets, whyLine, type TransferLeg } from './transfers.logic';
import type { TransfersState } from './useTransfers';

const WIDTH = 392;

function LegBox({ leg, selected, onPress }: { leg: TransferLeg; selected?: boolean; onPress?: () => void }) {
  const { formatMoney, formatDate } = useMoneyFormat();
  const cents = milliToCents(leg.amount);
  const body = (
    <>
      <Text style={styles.boxAccount} numberOfLines={2}>
        {leg.account_name}
      </Text>
      <Text style={styles.boxPayee} numberOfLines={2}>
        {leg.payee_name}
      </Text>
      <Text style={styles.boxMeta}>
        <Text style={cents < 0 ? styles.neg : styles.pos}>
          {cents < 0 ? '– ' : '+ '}
          {formatMoney(Math.abs(cents))}
        </Text>
        {` · ${formatDate(leg.date)}`}
      </Text>
    </>
  );
  if (!onPress) return <View style={styles.box}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={t('popover.candidate', { account: leg.account_name, date: formatDate(leg.date) })}
      style={[styles.box, styles.choice, selected && styles.choiceOn]}>
      {body}
    </Pressable>
  );
}

function NoMatchBox() {
  return (
    <View style={[styles.box, styles.boxEmpty]}>
      <Text style={styles.boxPayee}>{t('popover.noMatch')}</Text>
      <Text style={styles.muted}>{t('popover.noMatchSub')}</Text>
    </View>
  );
}

export function TransferPopover({
  item,
  txnId,
  anchor,
  isPhone,
  accounts,
  actions,
  onClose,
}: {
  item: TransferSuggestion;
  txnId: string;
  anchor: { x: number; y: number };
  isPhone: boolean;
  accounts: readonly Account[];
  actions: Pick<TransfersState, 'linkMany' | 'dismiss' | 'keepOutside'>;
  onClose: () => void;
}) {
  const win = useWindowDimensions();
  const [pick, setPick] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [mode, setMode] = useState<'main' | 'other'>('main');
  const sides = popoverSides(item, txnId, pick);
  const payee = sides.row.payee_name;

  const done = (ok: boolean) => {
    if (ok) onClose();
  };
  const cardStyle = isPhone
    ? styles.sheet
    : [
        styles.card,
        {
          left: Math.max(8, Math.min(anchor.x - 40, win.width - WIDTH - 8)),
          top: Math.max(8, Math.min(anchor.y + 16, win.height - 380)),
        },
      ];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.scrim, isPhone && styles.scrimPhone]} onPress={onClose} accessibilityLabel={t('popover.close')}>
        <Pressable style={cardStyle} onPress={(e) => e.stopPropagation()}>
          <ScrollView style={{ maxHeight: isPhone ? win.height * 0.8 : 520 }} contentContainerStyle={{ paddingBottom: 2 }}>
            {mode === 'main' ? (
              <>
                <Text style={styles.title}>{t('popover.title')}</Text>
                <Text style={styles.muted}>{t('popover.sub')}</Text>
                <View style={styles.pair}>
                  {sides.from ? <LegBox leg={sides.from} /> : <NoMatchBox />}
                  <Text style={styles.arrow}>→</Text>
                  {sides.to ? <LegBox leg={sides.to} /> : sides.choices.length > 0 ? <View style={[styles.box, styles.boxEmpty]}><Text style={styles.muted}>{t('popover.pick')}</Text></View> : <NoMatchBox />}
                </View>
                {sides.choices.length > 0 ? (
                  <View style={styles.choices}>
                    {sides.choices.map((c) => (
                      <LegBox key={c.transaction_id} leg={c} selected={pick === c.transaction_id} onPress={() => setPick(c.transaction_id)} />
                    ))}
                  </View>
                ) : null}
                <Text style={styles.why}>{whyLine(item, sides)}</Text>
                {payee ? (
                  <View style={styles.check}>
                    <SelectionCheckbox checked={remember} onToggle={() => setRemember(!remember)} label={t('popover.remember', { payee })} />
                    <Pressable style={{ flex: 1 }} onPress={() => setRemember(!remember)}>
                      <Text style={styles.checkText}>{t('popover.remember', { payee })}</Text>
                      <Text style={styles.muted}>{t('popover.rememberSub')}</Text>
                    </Pressable>
                  </View>
                ) : null}
                <View style={[styles.actions, isPhone && styles.actionsPhone]}>
                  <Pressable style={styles.btn} accessibilityRole="button" onPress={() => void actions.dismiss([sides.row.transaction_id]).then(done)}>
                    <Text style={styles.btnText}>{t('popover.notTransfer')}</Text>
                  </Pressable>
                  <Pressable style={styles.btn} accessibilityRole="button" onPress={() => setMode('other')}>
                    <Text style={styles.btnText}>{t('popover.otherAccount')}</Text>
                  </Pressable>
                  <View style={{ flex: 1 }} />
                  <Pressable
                    style={[styles.btn, styles.primary, !sides.link && styles.disabled]}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !sides.link }}
                    disabled={!sides.link}
                    onPress={() => sides.link && void actions.linkMany([sides.link], remember).then(done)}>
                    <Text style={styles.primaryText}>{t('popover.link')}</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.title}>{t('other.title')}</Text>
                {transferTargets(accounts, sides.row.account_id).map((a) => (
                  <Pressable
                    key={a.id}
                    style={styles.option}
                    accessibilityRole="button"
                    onPress={() => void actions.linkMany([{ transaction_id: sides.row.transaction_id, account_id: a.id }], remember).then(done)}>
                    <Text style={styles.checkText}>{a.name}</Text>
                  </Pressable>
                ))}
                <Pressable style={styles.option} accessibilityRole="button" onPress={() => void actions.keepOutside([sides.row.transaction_id]).then(done)}>
                  <Text style={styles.checkText}>{t('other.outside')}</Text>
                  <Text style={styles.muted}>{t('other.outsideSub')}</Text>
                </Pressable>
                <View style={styles.actions}>
                  <Pressable style={styles.btn} accessibilityRole="button" onPress={() => setMode('main')}>
                    <Text style={styles.btnText}>{t('other.back')}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.25)' },
  scrimPhone: { justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,.55)' },
  card: {
    position: 'absolute',
    width: WIDTH,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.blueBorder,
    borderRadius: radius.r,
    padding: 14,
    shadowColor: colors.black,
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
  sheet: {
    backgroundColor: colors.card2,
    borderTopLeftRadius: radius.r,
    borderTopRightRadius: radius.r,
    borderWidth: 1,
    borderColor: colors.blueBorder,
    padding: 16,
    paddingBottom: 28,
  },
  title: { color: colors.text, fontSize: 14, fontWeight: '700', marginBottom: 2 },
  muted: { color: colors.muted, fontSize: 11 },
  pair: { flexDirection: 'row', alignItems: 'stretch', gap: 6, marginVertical: 10 },
  arrow: { color: colors.blue, fontWeight: '800', alignSelf: 'center', width: 18, textAlign: 'center' },
  box: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 8, backgroundColor: colors.bg2, gap: 2 },
  boxEmpty: { justifyContent: 'center', borderStyle: 'dashed' },
  boxAccount: { color: colors.text, fontSize: 12, fontWeight: '700' },
  boxPayee: { color: colors.text, fontSize: 12 },
  boxMeta: { color: colors.muted, fontSize: 12 },
  neg: { color: colors.redFg, fontWeight: '600' },
  pos: { color: colors.greenPillFg, fontWeight: '600' },
  choices: { gap: 6, marginBottom: 8 },
  choice: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  choiceOn: { borderColor: colors.blue, backgroundColor: colors.blueSoft },
  why: { color: colors.muted, fontSize: 11, marginVertical: 6 },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginVertical: 8 },
  checkText: { color: colors.text, fontSize: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  actionsPhone: { flexWrap: 'wrap', rowGap: 8 },
  btn: { borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingVertical: 5, paddingHorizontal: 9 },
  btnText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  primary: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  primaryText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  option: { borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 9, gap: 2 },
});
