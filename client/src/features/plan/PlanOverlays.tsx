/**
 * The Plan screen's money overlays: header Assign dropdown, auto-assign,
 * the pill's move/cover popover, move-money sheets, the phone detail page
 * and the phone assign numpad.
 */
import { Pressable, useWindowDimensions } from 'react-native';

import { AssignDropdownBody } from './AssignDropdown';
import { AutoAssignPanel } from './AutoAssignPanel';
import { MobileAssignNumpad } from './MobileAssignNumpad';
import { MobileCategoryDetail } from './MobileCategoryDetail';
import { MobileMoveMoney } from './MobileMoveMoney';
import { MoveMoneyPopover, MoveMoneySheet } from './MoveMoneySheet';
import { pillPopPosition } from './planGeometry.logic';
import { styles } from './styles';
import type { PlanGrid } from './types';

export function PlanOverlays({ grid }: { grid: PlanGrid }) {
  const { budget, budgetId, month, shell, byPerson, overlays, numpad, undo } = grid;
  const { assignPos, pillPop, moveReq, mobileDetailId } = overlays;
  const { numpadId, closeNumpad } = numpad;
  const dims = useWindowDimensions();
  const rta = grid.bm.readyToAssign;
  return (
    <>
      {/* 4rr: header Assign dropdown (portal-less, backdrop + measured anchor) */}
      {overlays.assignOpen && assignPos ? (
        <Pressable style={styles.menuBackdrop} onPress={() => overlays.setAssignOpen(false)}>
          <Pressable
            style={[styles.assignCard, { top: assignPos.top, right: assignPos.right }]}
            onPress={() => undefined}>
            <AssignDropdownBody
              budget={budget}
              budgetId={budgetId}
              month={month}
              rtaCents={rta}
              onDone={() => overlays.setAssignOpen(false)}
            />
          </Pressable>
        </Pressable>
      ) : null}
      {overlays.autoAssignOpen ? (
        <AutoAssignPanel
          visible
          onClose={() => overlays.setAutoAssignOpen(false)}
          budget={budget}
          budgetId={budgetId}
          month={month}
          rtaCents={rta}
        />
      ) : null}
      {/* pjtv: YNAB-anchored move/cover popover under the pressed pill (web). */}
      {pillPop ? (
        <Pressable style={styles.menuBackdrop} onPress={() => overlays.setPillPop(null)}>
          <Pressable style={[styles.pillPopCard, pillPopPosition(pillPop, dims)]} onPress={() => undefined}>
            <MoveMoneyPopover
              budget={budget}
              budgetId={budgetId}
              month={month}
              request={pillPop.req}
              onClose={() => overlays.setPillPop(null)}
            />
          </Pressable>
        </Pressable>
      ) : null}
      {moveReq ? (
        shell.isPhone ? (
          <MobileMoveMoney
            visible
            onClose={() => overlays.setMoveReq(null)}
            budget={budget}
            budgetId={budgetId}
            month={month}
            request={moveReq}
          />
        ) : (
          <MoveMoneySheet
            visible
            onClose={() => overlays.setMoveReq(null)}
            budget={budget}
            budgetId={budgetId}
            month={month}
            request={moveReq}
          />
        )
      ) : null}
      {mobileDetailId && budget.categories.some((c) => c.id === mobileDetailId) ? (
        <MobileCategoryDetail
          visible
          budget={budget}
          budgetId={budgetId}
          month={month}
          category={budget.categories.find((c) => c.id === mobileDetailId)!}
          activityMap={byPerson.activity}
          personName={byPerson.label}
          onClose={() => overlays.setMobileDetailId(null)}
          onMoveMoney={(req) => {
            overlays.setMobileDetailId(null);
            overlays.setMoveReq(req);
          }}
        />
      ) : null}
      {numpadId && budget.categories.some((c) => c.id === numpadId) ? (
        <MobileAssignNumpad
          key={numpadId}
          onClose={closeNumpad}
          budget={budget}
          budgetId={budgetId}
          month={month}
          category={budget.categories.find((c) => c.id === numpadId)!}
          state={numpad.numpadState}
          onKey={numpad.onNumpadKey}
          onMoveMoney={() => {
            closeNumpad();
            overlays.setMoveReq({ from: numpadId });
          }}
          onMoreDetails={() => {
            closeNumpad();
            overlays.setMobileDetailId(numpadId);
          }}
          recordAssigned={undo.recordAssigned}
          panelRef={numpad.panelRef}
        />
      ) : null}
    </>
  );
}
