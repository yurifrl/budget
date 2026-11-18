/** Plan topbar: month switcher + Ready-to-Assign banner, and the negative-RTA "Fix This" strip. */
import { useRef, type ComponentRef } from 'react';
import { Pressable, Text, View, type ViewInstance } from 'react-native';

import { useAppDispatch } from '@/state/hooks';

import { formatMonth, nextMonth, prevMonth } from '@/domain/format';
import { PERSON_ALL } from '@/domain/people';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { setActiveMonth } from '@/state/ui';
import { IndigoButton } from '@/ui/bits';
import { colors } from '@/ui/theme';
import { assignDropdownAnchor } from './planGeometry.logic';
import { styles } from './styles';
import type { PlanGrid } from './types';

export function PlanTopbar({ grid }: { grid: Pick<PlanGrid, 'shell' | 'month' | 'bm' | 'byPerson' | 'overlays' | 'anchorAt'> }) {
  const { shell, month, byPerson, overlays, anchorAt } = grid;
  const { formatMoney } = useMoneyFormat();
  const dispatch = useAppDispatch();
  const assignBtnRef = useRef<ViewInstance>(null);
  const fixBtnRef = useRef<ComponentRef<typeof Pressable>>(null);
  const rta = grid.bm.readyToAssign;
  return (
    <>
      {/* topbar: month switcher + RTA banner */}
      <View style={[styles.topbar, shell.isPhone && { flexWrap: 'wrap', justifyContent: 'center' }]}>
        <View style={styles.month}>
          <Pressable
            style={styles.navm}
            onPress={() => dispatch(setActiveMonth(prevMonth(month)))}
            accessibilityLabel="Previous month">
            <Text style={{ color: colors.muted }}>‹</Text>
          </Pressable>
          <Text style={styles.monthLabel}>{formatMonth(month)}</Text>
          <Pressable
            style={styles.navm}
            onPress={() => dispatch(setActiveMonth(nextMonth(month)))}
            accessibilityLabel="Next month">
            <Text style={{ color: colors.muted }}>›</Text>
          </Pressable>
        </View>
        <View style={[styles.rta, shell.isPhone && { flexBasis: '100%', marginLeft: 0 }]}>
          <View>
            <Text style={[styles.rtaAmount, rta < 0 && { color: colors.redFg }]}>{formatMoney(rta)}</Text>
            <Text style={styles.rtaSub}>
              Ready to Assign{byPerson.person !== PERSON_ALL ? ' · household' : ''}
            </Text>
          </View>
          <View ref={assignBtnRef}>
            <IndigoButton
              label="Assign ›"
              onPress={() => {
                assignBtnRef.current?.measureInWindow((x, y, width, height) => {
                  overlays.setAssignPos(assignDropdownAnchor({ x, y, width, height }, window.innerWidth));
                });
                overlays.setAssignOpen(true);
              }}
            />
          </View>
        </View>
      </View>
      {/* ubgb: YNAB negative-RTA banner — red strip + Fix This opening the
          un-assign popover (web) / minimal sheet (native). */}
      {rta < 0 ? (
        <View style={styles.rtaFixBanner}>
          <Text style={styles.rtaFixText}>You&apos;ve assigned more money than you have.</Text>
          <Pressable
            ref={fixBtnRef}
            accessibilityRole="button"
            accessibilityLabel="Fix overspending"
            onPress={() =>
              // ubgb: measureInWindow anchor (event coords are unreliable for
              // synthetic/CDP presses — same rationale as the pill popovers).
              fixBtnRef.current?.measureInWindow((px, py, pw, ph) =>
                anchorAt(px + pw, py + ph + 3, (x, y) =>
                  overlays.openMoveAt({ from: null, to: null, unassign: true }, x, y),
                ),
              )
            }>
            <Text style={styles.rtaFixAction}>Fix This</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}
