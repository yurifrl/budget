/**
 * The Transfers section at the top of the Categorize page: one card per account
 * pair for BOTH kinds of transfer question — the matcher's own suggestions and
 * Jev's "this is a transfer" answers — so the page asks one thing in two halves.
 * A card heads its pair and the money it moves; Jev's card answers its whole
 * pair at once. Each row carries its amount, the date, both accounts, how sure
 * it is and what can be done with it. Only the certainty pill differs: the
 * matcher names its match kind ("sure", "choose"), Jev its confidence ("93%").
 * Nothing renders when there is nothing to show.
 */

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { milliToCents } from '@/budget/data/mapping';
import {
  MatchPill,
  TransferPopover,
  suggestionPairs,
  type ReviewRow,
  type SuggestionPairView,
} from '@/features/transfers';
import { useBudgetModel } from '@/state/useBudgetModel';
import { GhostButton, IndigoButton, TagPill } from '@/ui/bits';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';

import { t } from './i18n';
import { confidenceBand, type ConfidenceBand } from './queue.logic';
import {
  matcherHeading,
  transferPercent,
  transferSides,
  transferSubject,
  type TransferGroupView,
  type TransferItem,
} from './transfer.logic';
import type { CategorizeTransfers } from './useCategorizeTransfers';

const TONE: Record<ConfidenceBand, 'green' | 'yellow' | 'gray'> = {
  high: 'green',
  mid: 'yellow',
  low: 'gray',
};

export function TransferSection({
  transfers,
  isPhone,
}: {
  /** The page's own wiring: the One by one view answers the same rows. */
  transfers: CategorizeTransfers;
  isPhone: boolean;
}) {
  const { budget } = useBudgetModel();
  const matcher = transfers.matcherState;
  const pairs = suggestionPairs(matcher.scoped);
  const empty = pairs.length === 0 && transfers.groups.length === 0;
  // Nothing to show and nothing in flight or broken: the page is just bundles.
  const quiet = !transfers.loading && !matcher.loading && !transfers.failed && !matcher.failed;
  if (empty && quiet) return null;

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text style={styles.title}>{t('transfer.title')}</Text>
      </View>

      {transfers.failed ? (
        <View style={styles.failure}>
          <Text style={styles.muted}>{t('transfer.loadFailed')}</Text>
          <GhostButton label={tCommon('retry')} onPress={transfers.retry} />
        </View>
      ) : null}

      {matcher.failed ? (
        <View style={styles.failure}>
          <Text style={styles.muted}>{t('transfer.matcherFailed')}</Text>
          <GhostButton label={tCommon('retry')} onPress={matcher.retry} />
        </View>
      ) : pairs.length > 0 || matcher.loading ? (
        <>
          <Text style={styles.sub}>{t('transfer.matcherHeading')}</Text>
          {pairs.length > 0 ? (
            <View style={styles.cards}>
              {pairs.map((group) => (
                <MatcherCard key={group.key} group={group} matcher={matcher} />
              ))}
            </View>
          ) : (
            <Text style={styles.muted}>{tCommon('loading')}</Text>
          )}
        </>
      ) : null}

      {transfers.groups.length > 0 ? (
        <>
          <Text style={styles.sub}>{t('transfer.jevHeading')}</Text>
          <View style={styles.cards}>
            {transfers.groups.map((group) => (
              <GroupCard
                key={group.key}
                group={group}
                onAcceptAll={() => void transfers.acceptGroup(group)}
                onAccept={(item) => void transfers.actions.accept(item)}
                onRefuse={(item) => void transfers.actions.refuse(item)}
                onSkip={(item) => void transfers.actions.skip(item)}
              />
            ))}
          </View>
        </>
      ) : null}

      {/* A rule of its own: the bundles below are a different question. */}
      <View style={styles.divider} />
      {matcher.popover && matcher.popoverItem ? (
        <TransferPopover
          item={matcher.popoverItem}
          txnId={matcher.popover.txnId}
          anchor={{ x: matcher.popover.x, y: matcher.popover.y }}
          isPhone={isPhone}
          accounts={budget?.accounts ?? []}
          actions={matcher}
          onClose={matcher.closePopover}
        />
      ) : null}
    </View>
  );
}

/**
 * The shell both halves share: the pair's heading, what it is worth and — for
 * a pair that can be answered at once — one button for all of it.
 */
function PairCard({
  heading,
  detail,
  total,
  action,
  children,
}: {
  heading: string;
  detail: string;
  total: string;
  /** The pair button; omitted when the rows answer one by one. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardTitle}>
          <Text style={styles.heading}>{heading}</Text>
          <Text style={styles.pair} numberOfLines={1}>
            {detail}
          </Text>
        </View>
        <Text style={styles.total}>{total}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

/** One account pair of the matcher's suggestions, in the card Jev's pairs get. */
function MatcherCard({ group, matcher }: { group: SuggestionPairView; matcher: CategorizeTransfers['matcherState'] }) {
  const { formatMoney } = useMoneyFormat();
  const links = group.rows.flatMap((row) => (row.link ? [row.link] : []));
  return (
    <PairCard
      heading={matcherHeading(group)}
      detail={t('transfer.count', { count: group.rows.length })}
      total={formatMoney(group.total)}
      action={
        links.length > 1 ? (
          <IndigoButton
            label={t('transfer.acceptPair', { count: links.length })}
            onPress={() => void matcher.linkMany(links)}
          />
        ) : null
      }>
      {group.rows.map((row) => (
        <MatcherRow
          key={row.id}
          row={row}
          onAccept={() => row.link && void matcher.linkMany([row.link])}
          onRefuse={() => void matcher.dismiss(row.dismissIds)}
          onPick={(x, y) => matcher.openPopover(row.id, x, y)}
        />
      ))}
    </PairCard>
  );
}

function MatcherRow({
  row,
  onAccept,
  onRefuse,
  onPick,
}: {
  row: ReviewRow;
  onAccept: () => void;
  onRefuse: () => void;
  onPick: (x: number, y: number) => void;
}) {
  const { formatMoney, formatDateShort } = useMoneyFormat();
  const payee = row.payee.trim() === '' ? t('row.unnamed') : row.payee;
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.subject} numberOfLines={1}>
          {t('transfer.subject', { payee, amount: formatMoney(row.from ? -row.amount : row.amount) })}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {formatDateShort(row.date)} · {matcherHeading({ fromAccount: row.from?.account_name ?? null, toAccount: row.to?.account_name ?? null })}
        </Text>
        {row.reason ? (
          <Text style={styles.reason} numberOfLines={2}>
            {row.reason}
          </Text>
        ) : null}
      </View>
      <MatchPill kind={row.match} />
      <View style={styles.actions}>
        {row.link ? (
          <IndigoButton label={t('transfer.accept')} onPress={onAccept} />
        ) : (
          <PickButton label={t('transfer.choose')} onPick={onPick} />
        )}
        <GhostButton label={t('transfer.refuse')} onPress={onRefuse} />
      </View>
    </View>
  );
}

/** A ghost button that hands its press point to the popover's anchor. */
function PickButton({ label, onPick }: { label: string; onPick: (x: number, y: number) => void }) {
  return (
    <Pressable
      onPress={(event) => onPick(event.nativeEvent.pageX, event.nativeEvent.pageY)}
      style={styles.btnGhost}
      accessibilityRole="button">
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

/** One account pair of Jev's answers: heading, the two sides, its rows and sum. */
function GroupCard({
  group,
  onAcceptAll,
  onAccept,
  onRefuse,
  onSkip,
}: {
  group: TransferGroupView;
  /** The group button answers every row of the pair at once. */
  onAcceptAll: () => void;
  onAccept: (item: TransferItem) => void;
  onRefuse: (item: TransferItem) => void;
  onSkip: (item: TransferItem) => void;
}) {
  const { formatMoney } = useMoneyFormat();
  return (
    <PairCard
      heading={group.heading}
      detail={group.pair}
      total={formatMoney(Math.abs(milliToCents(group.total)))}
      action={
        group.items.length > 1 ? (
          <IndigoButton label={t('transfer.acceptPair', { count: group.items.length })} onPress={onAcceptAll} />
        ) : null
      }>
      {group.items.map((item) => (
        <TransferRow
          key={item.transaction_id}
          item={item}
          onAccept={() => onAccept(item)}
          onRefuse={() => onRefuse(item)}
          onSkip={() => onSkip(item)}
        />
      ))}
    </PairCard>
  );
}

function TransferRow({
  item,
  onAccept,
  onRefuse,
  onSkip,
}: {
  item: TransferItem;
  onAccept: () => void;
  onRefuse: () => void;
  onSkip: () => void;
}) {
  const { formatMoney, formatDateShort } = useMoneyFormat();
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.subject} numberOfLines={1}>
          {transferSubject(item, formatMoney)}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {formatDateShort(item.date)} · {transferSides(item)}
        </Text>
      </View>
      <TagPill
        label={t('transfer.percent', { percent: transferPercent(item.confidence) })}
        tone={TONE[confidenceBand(item.confidence)]}
      />
      <View style={styles.actions}>
        <IndigoButton label={t('transfer.accept')} onPress={onAccept} />
        <GhostButton label={t('transfer.refuse')} onPress={onRefuse} />
        <GhostButton label={t('transfer.skip')} onPress={onSkip} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  divider: { height: 1, backgroundColor: colors.border2, marginTop: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  sub: { color: colors.faint, fontSize: 10, fontWeight: '700', letterSpacing: 0.7, marginTop: 2 },
  failure: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  muted: { color: colors.muted, fontSize: 12 },
  cards: { gap: 8 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  cardHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.bg2,
  },
  cardTitle: { flexBasis: 200, flexGrow: 1, minWidth: 140 },
  heading: { color: colors.text, fontSize: 13, fontWeight: '700' },
  pair: { color: colors.muted, fontSize: 11 },
  total: { color: colors.text, fontSize: 13, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border2,
  },
  rowMain: { flexBasis: 220, flexGrow: 1, minWidth: 160 },
  subject: { color: colors.text, fontSize: 13 },
  meta: { color: colors.muted, fontSize: 11 },
  reason: { color: colors.yellowPillFg, fontSize: 11 },
  actions: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  btnGhost: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 13,
    alignItems: 'center',
  },
  btnText: { color: colors.text, fontWeight: '600', fontSize: 13 },
});
