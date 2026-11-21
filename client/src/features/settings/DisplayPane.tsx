import { useAppDispatch, useAppSelector } from '@/state/hooks';

import {
  selectShowClosedAccounts,
  selectShowHiddenCategories,
  selectShowProgressBars,
  setShowClosedAccounts,
  setShowHiddenCategories,
  setShowProgressBars,
} from '@/state/ui';
import { t } from './i18n';
import { LanguageRow } from './LanguageRow';
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
        label={t('display.bars')}
        sub={t('display.barsSub')}
        value={showBars}
        onChange={(v) => {
          dispatch(setShowProgressBars(v));
        }}
      />
      <ToggleRow
        label={t('display.hidden')}
        sub={t('display.hiddenSub')}
        value={showHidden}
        onChange={(v) => {
          dispatch(setShowHiddenCategories(v));
        }}
      />
      <ToggleRow
        label={t('display.closed')}
        sub={t('display.closedSub')}
        value={showClosed}
        onChange={(v) => {
          dispatch(setShowClosedAccounts(v));
        }}
      />
      <LanguageRow />
    </>
  );
}
