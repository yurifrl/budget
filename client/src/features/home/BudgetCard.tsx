/**
 * One budget on the home page: its name, who is on it (and who shared it),
 * and what the person may do with it. The card body opens the budget; the
 * people button is a sibling, not a child, so neither nests a button.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { BudgetListRow } from '@/budget/data/rows';
import { Avatar } from '@/ui/avatar/Avatar';
import { colors, radius } from '@/ui/theme';

import { budgetCardActions, budgetCardCaption } from './home.logic';
import { t } from './i18n';

interface Props {
  budget: BudgetListRow;
  /** Extra caption for archived budgets ("Archived 01/02/2026"). */
  archivedNote?: string;
  onOpen: () => void;
  onPeople: () => void;
}

export function BudgetCard({ budget, archivedNote, onOpen, onPeople }: Props) {
  const actions = budgetCardActions(budget);
  const caption = budgetCardCaption(budget);
  const owner = budget.is_owner ? null : budget.owner;
  return (
    <View style={styles.card}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={t('card.open', { name: budget.name })}
        style={(state) => [
          styles.main,
          (state.pressed || ('hovered' in state && state.hovered === true)) && styles.mainActive,
        ]}>
        {owner ? (
          <Avatar
            person={{ id: owner.user_id, avatar: owner.avatar, name: owner.name, email: owner.email }}
            size={36}
          />
        ) : null}
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
            {budget.name}
          </Text>
          {(archivedNote ? [archivedNote, ...caption] : caption).map((line) => (
            <Text key={line} style={styles.caption} numberOfLines={1} ellipsizeMode="middle">
              {line}
            </Text>
          ))}
        </View>
        <Text style={styles.chevron}>{'›'}</Text>
      </Pressable>
      {actions.people ? (
        <Pressable
          onPress={onPeople}
          accessibilityRole="button"
          accessibilityLabel={
            actions.people === 'Invite'
              ? t('people.inviteLabel', { name: budget.name })
              : t('people.title', { name: budget.name })
          }
          style={(state) => [
            styles.people,
            (state.pressed || ('hovered' in state && state.hovered === true)) && styles.peopleActive,
          ]}>
          <Text style={styles.peopleText}>{actions.people === 'Invite' ? t('card.invite') : t('card.people')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.r,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  main: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingLeft: 16, paddingRight: 10, minHeight: 68 },
  mainActive: { backgroundColor: colors.card2 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
  caption: { color: colors.muted, fontSize: 14, lineHeight: 19 },
  chevron: { color: colors.faint, fontSize: 22 },
  people: {
    justifyContent: 'center',
    paddingHorizontal: 18,
    minWidth: 84,
    alignItems: 'center',
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  peopleActive: { backgroundColor: colors.card2 },
  peopleText: { color: colors.indigo3, fontSize: 14, fontWeight: '700' },
});
