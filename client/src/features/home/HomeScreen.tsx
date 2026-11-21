/**
 * Home: the first thing a signed-in person sees, outside any budget. Their
 * budgets, the budgets other people shared with them, a way to create one and
 * to invite people, and the way to their profile and out. With no budgets it
 * is the first-run page. One component for web and iOS, in the frame the
 * landing page uses (ui/BrandedPage). Data and actions: useHome; rules and
 * copy: home.logic.
 */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import type { BudgetListRow } from '@/budget/data/rows';
import { PRODUCT_NAME, useAuthSession } from '@/features/auth';
import { MeAvatarButton } from '@/features/profile';
import { BrandedPage } from '@/ui/BrandedPage';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius, spacing } from '@/ui/theme';

import { BudgetCard } from './BudgetCard';
import { CreateBudgetForm } from './CreateBudgetForm';
import { archivedNote, emptyBody } from './home.logic';
import { t } from './i18n';
import { PeopleSheet } from './PeopleSheet';
import { useHome } from './useHome';

export function HomeScreen() {
  const home = useHome();
  const { signOut } = useAuthSession();
  const { formatDate } = useMoneyFormat();
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [peopleOf, setPeopleOf] = useState<{ id: string; name: string } | null>(null);
  const { view, sections, split } = home;

  const account = (
    <View style={styles.account}>
      <Pressable onPress={() => void signOut()} accessibilityRole="button" accessibilityLabel={t('header.signOut')} hitSlop={8}>
        <Text style={styles.accountLink}>{t('header.signOut')}</Text>
      </Pressable>
      <MeAvatarButton size={36} />
    </View>
  );

  const form = (autoFocus: boolean) => (
    <CreateBudgetForm
      onCreate={home.create}
      creating={home.creating}
      error={home.createError}
      onEdit={home.clearCreateError}
      autoFocus={autoFocus}
      inline={split}
    />
  );

  const cards = (rows: BudgetListRow[], archived = false) =>
    rows.map((b) => (
      <BudgetCard
        key={b.id}
        budget={b}
        archivedNote={archived ? archivedNote(b.archived_at, formatDate) : undefined}
        onOpen={() => void home.open(b.id)}
        onPeople={() => setPeopleOf({ id: b.id, name: b.name })}
      />
    ));

  return (
    <BrandedPage productName={PRODUCT_NAME} split={split} align="top" trailing={account}>
      <View style={styles.column}>
        <View style={styles.head}>
          <Text accessibilityRole="header" style={[styles.headline, split && styles.headlineSplit]}>
            {home.greeting}
          </Text>
          {view === 'list' && !creatingOpen ? (
            <Pressable
              onPress={() => setCreatingOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t('header.newBudget')}
              style={(state) => [
                styles.newButton,
                (state.pressed || ('hovered' in state && state.hovered === true)) && styles.newButtonActive,
              ]}>
              <Text style={styles.newButtonText}>{t('header.newBudget')}</Text>
            </Pressable>
          ) : null}
        </View>

        {view === 'loading' ? <ActivityIndicator size="large" color={colors.muted} style={styles.loading} /> : null}

        {view === 'error' ? (
          <>
            <View accessibilityRole="alert" style={styles.notice}>
              <Text style={styles.noticeText}>{t('error.loadFailed')}</Text>
            </View>
            <Pressable onPress={() => void home.refetch()} accessibilityRole="button" style={styles.newButton}>
              <Text style={styles.newButtonText}>{t('error.retry')}</Text>
            </Pressable>
          </>
        ) : null}

        {view === 'empty' ? (
          <>
            <Text style={styles.body}>{emptyBody()}</Text>
            {form(false)}
          </>
        ) : null}

        {view === 'list' ? (
          <>
            {creatingOpen ? (
              <View style={styles.createPanel}>
                {form(true)}
                <Pressable
                  onPress={() => {
                    setCreatingOpen(false);
                    home.clearCreateError();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('create.cancelLabel')}
                  hitSlop={8}>
                  <Text style={styles.accountLink}>{tCommon('cancel')}</Text>
                </Pressable>
              </View>
            ) : null}

            <Section title={t('section.mine')}>
              {sections.mine.length ? (
                cards(sections.mine)
              ) : (
                <Text style={styles.sectionEmpty}>{t('section.mineEmpty')}</Text>
              )}
            </Section>

            <Section title={t('section.shared')}>
              {sections.shared.length ? (
                cards(sections.shared)
              ) : (
                <Text style={styles.sectionEmpty}>{t('section.sharedEmpty')}</Text>
              )}
            </Section>

            {sections.archived.length ? (
              <View style={styles.section}>
                <Pressable
                  onPress={() => setArchivedOpen((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: archivedOpen }}
                  accessibilityLabel={t('section.archivedLabel', { count: sections.archived.length })}
                  hitSlop={8}>
                  <Text style={styles.sectionTitle}>
                    {archivedOpen ? '▾' : '▸'} {t('section.archived', { count: sections.archived.length })}
                  </Text>
                </Pressable>
                {archivedOpen ? cards(sections.archived, true) : null}
              </View>
            ) : null}
          </>
        ) : null}
      </View>

      <PeopleSheet budget={peopleOf} onClose={() => setPeopleOf(null)} />
    </BrandedPage>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { width: '100%', maxWidth: 600, gap: spacing.lg },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
  headline: { color: colors.text, fontSize: 34, lineHeight: 38, fontWeight: '800', letterSpacing: -0.8, flexShrink: 1 },
  headlineSplit: { fontSize: 44, lineHeight: 48, letterSpacing: -1.2 },
  body: { color: colors.text, fontSize: 17, lineHeight: 26 },
  loading: { marginTop: 48, alignSelf: 'flex-start' },

  account: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  accountLink: { color: colors.muted, fontSize: 14, fontWeight: '600' },

  newButton: {
    minHeight: 44,
    paddingHorizontal: 20,
    borderRadius: radius.card10,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.indigo,
  },
  newButtonActive: { backgroundColor: colors.indigo2 },
  newButtonText: { color: colors.white, fontSize: 15, fontWeight: '700' },
  createPanel: { gap: 12, alignItems: 'stretch' },

  notice: { backgroundColor: colors.redPillBg, borderRadius: radius.card10, paddingVertical: 12, paddingHorizontal: 14 },
  noticeText: { color: colors.redFg, fontSize: 15, lineHeight: 21 },

  section: { gap: 10 },
  sectionTitle: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  sectionEmpty: { color: colors.muted, fontSize: 14, lineHeight: 20 },
});
