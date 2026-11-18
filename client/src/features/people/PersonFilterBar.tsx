/**
 * The budget-wide "by person" filter row + its caption (Plan, Reflect,
 * Spending): Everyone, Shared, then one
 * chip per member (avatar + first name). Selection lives in redux
 * (`setPersonFilter`); the derived model comes from model/usePersonFilter.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AvatarStack } from '@/ui/avatar/AvatarStack';
import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { useAppDispatch } from '@/state/hooks';

import { loadBudgetSettings, saveBudgetSettingsPatch } from '@/budget/data/settingsBlob';
import {
  PERSON_ALL,
  PERSON_SHARED,
  personFirstName,
  personLabel,
  SHARED_LABEL,
  toAvatarPerson,
  type Person,
} from '@/domain/people';
import type { PersonFilterModel } from './usePersonFilter';
import { setPersonFilter } from '@/state/ui';
import { useBudgetShell } from '@/shell/context';
import { PersonFace, SharedGlyph } from '@/ui/PersonFace';
import { colors, radius } from '@/ui/theme';

export function PersonFilterBar({
  byPerson,
  budgetId,
  caption,
  showOwnsNoneHint = false,
}: {
  byPerson: PersonFilterModel;
  budgetId: string | null;
  /** Screen-specific line under the chips ("what this selection means here"); shown when a person is selected. */
  caption: string | null;
  /** Plan-only hint: the selected member owns no category yet. */
  showOwnsNoneHint?: boolean;
}) {
  const dispatch = useAppDispatch();
  const { isPhone, openPeople } = useBudgetShell();
  if (!byPerson.showRow) return <AddPeoplePrompt budgetId={budgetId} onOpen={openPeople} />;
  const options: { key: string; label: string; a11y: string; face: ReactNode }[] = [
    {
      key: PERSON_ALL,
      label: 'Everyone',
      a11y: 'Everyone',
      face: <AvatarStack people={byPerson.people.map(toAvatarPerson)} max={3} size={16} ring={colors.card} />,
    },
    { key: PERSON_SHARED, label: SHARED_LABEL, a11y: SHARED_LABEL, face: <SharedGlyph size={18} /> },
    ...byPerson.people.map((p: Person) => ({
      key: p.user_id,
      label: personFirstName(p),
      a11y: personLabel(p),
      face: <PersonFace person={p} size={18} />,
    })),
  ];
  return (
    <View style={styles.personBar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, alignItems: 'center' }}
        accessibilityRole="radiogroup"
        accessibilityLabel="Filter by person">
        {isPhone ? null : <Text style={styles.personLabel}>Person</Text>}
        {options.map((o) => {
          const on = byPerson.person === o.key;
          return (
            <Pressable
              key={o.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`Person ${o.a11y}`}
              onPress={() => dispatch(setPersonFilter(o.key))}
              style={[styles.chip, on && styles.chipActive]}>
              {o.face}
              <Text style={[styles.chipText, on && { color: '#fff' }]} numberOfLines={1}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={openPeople}
          accessibilityRole="button"
          accessibilityLabel="Add people"
          style={styles.addChip}>
          <Text style={styles.addChipText}>＋</Text>
        </Pressable>
      </ScrollView>
      {byPerson.label && caption ? (
        <View style={styles.captionRow}>
          {byPerson.person === PERSON_SHARED || byPerson.selected ? (
            <PersonFace person={byPerson.selected} size={14} />
          ) : null}
          <Text style={styles.personCaption}>{caption}</Text>
        </View>
      ) : null}
      {showOwnsNoneHint && byPerson.ownsNone && byPerson.selected ? (
        <View style={styles.hint} accessibilityRole="text">
          <Text style={styles.hintText}>
            No categories assigned to {personFirstName(byPerson.selected)} yet — open a category and set its Person.
            Shared ones are shown below.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One short line: which categories show, and whose accounts feed Activity. */
export function planCaption(byPerson: PersonFilterModel): string {
  const { selected } = byPerson;
  if (byPerson.person === PERSON_SHARED || !selected) return 'Shared categories · Activity from Shared accounts';
  const first = personFirstName(selected);
  return `${first}’s categories + Shared · Activity from ${first}’s accounts`;
}

/**
 * Solo budget with nothing assigned: the person row would be pointless, so a
 * compact dismissible prompt explains where people come from instead.
 * Dismissal lives in the per-budget settings blob (display.peoplePromptDismissed).
 */
function AddPeoplePrompt({ budgetId, onOpen }: { budgetId: string | null; onOpen: () => void }) {
  const storage = useService(Tokens.Storage);
  // null = still loading: render nothing rather than flash the prompt.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!budgetId) return;
    let alive = true;
    void loadBudgetSettings(storage, budgetId).then((blob) => {
      if (alive) setDismissed(blob.display?.peoplePromptDismissed === true);
    });
    return () => {
      alive = false;
    };
  }, [storage, budgetId]);
  if (!budgetId || dismissed !== false) return null;
  return (
    <View style={styles.cta}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel="Add people"
        style={styles.ctaMain}>
        <Text style={styles.ctaText}>Planning with someone? </Text>
        <Text style={styles.ctaLink}>Add people →</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          setDismissed(true);
          void saveBudgetSettingsPatch(storage, budgetId, { display: { peoplePromptDismissed: true } });
        }}
        accessibilityRole="button"
        accessibilityLabel="Dismiss add people prompt"
        hitSlop={8}
        style={styles.ctaClose}>
        <Text style={styles.ctaCloseText}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  personBar: { paddingHorizontal: 20, marginBottom: 10, gap: 6 },
  personLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  captionRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  personCaption: { color: colors.muted, fontSize: 11, flexShrink: 1 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingLeft: 5,
    paddingRight: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  addChip: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border2,
  },
  addChipText: { color: colors.muted, fontSize: 14, lineHeight: 16 },
  hint: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  hintText: { color: colors.muted, fontSize: 12 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginHorizontal: 20,
    marginBottom: 10,
    paddingVertical: 4,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.indigoSoft,
    borderWidth: 1,
    borderColor: colors.border2,
    gap: 6,
  },
  ctaMain: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  ctaText: { color: colors.muted, fontSize: 12 },
  ctaLink: { color: colors.indigo3, fontSize: 12, fontWeight: '700' },
  ctaClose: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  ctaCloseText: { color: colors.faint, fontSize: 11 },
  chipText: { color: colors.muted, fontSize: 12, fontWeight: '600', maxWidth: 120 },
});
