import { useAppDispatch, useAppSelector } from '@/state/hooks';

import {
  selectShowClosedAccounts,
  selectShowHiddenCategories,
  selectShowProgressBars,
  setShowClosedAccounts,
  setShowHiddenCategories,
  setShowProgressBars,
} from '@/state/ui';
import { ToggleRow } from './menuRows';

/** Display Options: the RTK display toggles, persisted via the blob. */
export function DisplayPane() {
  const dispatch = useAppDispatch();
  const showBars = useAppSelector((s) =>
    selectShowProgressBars(s),
  );
  const showHidden = useAppSelector((s) =>
    selectShowHiddenCategories(s),
  );
  const showClosed = useAppSelector((s) =>
    selectShowClosedAccounts(s),
  );
  return (
    <>
      <ToggleRow
        label="Progress bars"
        sub="Funding bars under plan categories"
        value={showBars}
        onChange={(v) => {
          dispatch(setShowProgressBars(v));
        }}
      />
      <ToggleRow
        label="Hidden categories"
        sub="Show hidden categories in the Plan"
        value={showHidden}
        onChange={(v) => {
          dispatch(setShowHiddenCategories(v));
        }}
      />
      <ToggleRow
        label="Closed accounts"
        sub="Show the Closed group in the account rail"
        value={showClosed}
        onChange={(v) => {
          dispatch(setShowClosedAccounts(v));
        }}
      />
    </>
  );
}
