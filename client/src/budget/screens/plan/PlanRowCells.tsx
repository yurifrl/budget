/** Plan category row: the ASSIGNED cell (per form factor) and the AVAILABLE pill cell. */
import { Pressable, Text, View } from 'react-native';

import type { targetFundingState } from '../../domain/engine';
import { activityFor } from '../../domain/people';
import { numpadCellText, pillProgress } from '../../domain/planRow';
import type { Category, Cents } from '../../domain/types';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
import { MoneyInput, Pill } from '../../ui/bits';
import { colors } from '../../ui/theme';
import { styles } from './styles';
import type { PlanGrid } from './types';

/**
 * Middle column. Phone with a person selected: read-only ACTIVITY. Phone:
 * ASSIGNED, as the numpad's live equation while this row is being edited.
 * Desktop/tablet: ASSIGNED with a click-to-edit inline input.
 */
export function AssignedCell({ grid, category: c, assigned }: { grid: PlanGrid; category: Category; assigned: Cents }) {
  const { bm, shell, byPerson, phoneActivity, numpad, overlays, undo } = grid;
  const { formatMoney } = useMoneyFormat();
  if (phoneActivity) {
    return (
      <View style={styles.colNumPhone}>
        <Text style={[styles.numText, styles.numTextPhone, { color: colors.muted }]} numberOfLines={1}>
          {formatMoney(activityFor(bm, c.id, byPerson.activity))}
        </Text>
      </View>
    );
  }
  if (shell.isPhone) {
    const eq = numpad.numpadId === c.id ? numpadCellText(numpad.numpadState, assigned, { formatMoney }) : null;
    return (
      <View style={styles.colNumPhone}>
        {eq ? (
          eq.base !== null ? (
            // Stacked equation: old number on top, the pending
            // '+operand' under (YNAB parity), caret trailing.
            <>
              <Text
                style={[styles.numText, styles.numTextPhone, styles.numpadEditLine]}
                numberOfLines={1}>
                {eq.base}
              </Text>
              <Text
                style={[styles.numText, styles.numTextPhone, styles.numpadEditLine]}
                numberOfLines={1}>
                {eq.pending}
                |
              </Text>
            </>
          ) : (
            // Single line under '=': the typed operand, or the
            // (possibly just-resolved) base, caret trailing.
            <Text
              style={[styles.numText, styles.numTextPhone, styles.numpadEditLine]}
              numberOfLines={1}>
              {eq.pending + '|'}
            </Text>
          )
        ) : (
          <Text style={[styles.numText, styles.numTextPhone]} numberOfLines={1}>
            {formatMoney(assigned)}
          </Text>
        )}
      </View>
    );
  }
  return (
    <Pressable
      style={styles.colNum}
      onPress={() => overlays.setEditingId(c.id)}
      accessibilityLabel={`Edit assigned for ${c.name}`}>
      {overlays.editingId === c.id ? (
        <MoneyInput
          cents={assigned}
          autoFocus
          quickMath
          onEscape={() => overlays.setEditingId(null)}
          onCommit={(next) => {
            overlays.setEditingId(null);
            if (next !== assigned) undo.recordAssigned(c.id, next);
          }}
        />
      ) : (
        <Text style={styles.numText} numberOfLines={1}>
          {formatMoney(assigned)}
        </Text>
      )}
    </Pressable>
  );
}

export function AvailableCell({
  grid,
  category: c,
  funding,
  fraction,
  assigned,
  available,
}: {
  grid: PlanGrid;
  category: Category;
  funding: ReturnType<typeof targetFundingState>;
  fraction: number;
  assigned: Cents;
  available: Cents;
}) {
  const { month, shell, overlays, anchorAt, pillRefs } = grid;
  return (
    <View
      style={[styles.colAvail, shell.isPhone && styles.colAvailPhone]}
      ref={(el) => {
        if (el) pillRefs.current.set(c.id, el);
        else pillRefs.current.delete(c.id);
      }}>
      <Pill
        state={funding.state}
        cents={available}
        small={shell.isPhone}
        progress={pillProgress(c.target ?? null, month, assigned, fraction)}
        // Phone (xvu steer): the whole line opens the assign
        // numpad — no pill press; move money stays reachable
        // via the numpad/detail. Desktop/web keep the pill.
        onPress={shell.isPhone ? undefined : () =>
          // YNAB pill behavior (syscd-app-6jns): overspent →
          // "Cover overspending from"; otherwise "Move".
          // pjtv: web anchors the form under the pill via
          // measureInWindow (synthetic/CDP presses report
          // pageX≈0 — event coords unreliable); native keeps
          // the centered sheet.
          pillRefs.current.get(c.id)?.measureInWindow((px, py, pw, ph) =>
            anchorAt(px + pw, py + ph + 3, (x, y) =>
              overlays.openMoveAt(available < 0 ? { from: null, to: c.id, pickFrom: true } : { from: c.id }, x, y),
            ),
          )
        }
      />
    </View>
  );
}
