import { useEffect, useState } from 'react';
import { Text, TextInput } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

import { useGetBudgetsQuery, useRenameBudgetMutation } from '../../data/api';
import { loadBudgetSettings, saveBudgetSettingsPatch } from '../../data/settingsBlob';
import {
  DEFAULT_FMT_PREFS,
  type FmtCurrency,
  type FmtDateFormat,
  type FmtNumberLocale,
  type FmtPlacement,
  type FmtPrefs,
} from '../../domain/fmtPrefs';
import { useFmtPrefs, useMoneyMask } from '../../model/useDisplayPrefs';
import { selectActiveBudgetId, setFmtPrefs } from '../../state/ui';
import { BudgetManageSection } from './BudgetManageSection';
import { MenuRow, Seg } from './menuRows';
import { fmtPreviewText } from './settings.logic';
import { s } from './styles';

/** Plan Settings: name PATCH + format prefs with live preview. */
export function PlanSettingsPane({ budgetId }: { budgetId: string | null }) {
  const storage = useService(Tokens.Storage);
  const dispatch = useAppDispatch();
  const budgets = useGetBudgetsQuery();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const activeBudget = budgets.data?.find((b) => b.id === budgetId);
  const [renameBudget] = useRenameBudgetMutation();
  const [planName, setPlanName] = useState(activeBudget?.name ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = budgetId === activeBudgetId;
  const fmt = useFmtPrefs();
  const [masked] = useMoneyMask();
  // Non-live targets are configured straight from their saved blob: the
  // global fmt store belongs to the ACTIVE budget and must not be touched.
  const [blobFmt, setBlobFmt] = useState<FmtPrefs>(DEFAULT_FMT_PREFS);
  useEffect(() => {
    if (live || !budgetId) return;
    let cancelled = false;
    void loadBudgetSettings(storage, budgetId).then((loaded) => {
      if (!cancelled && loaded.fmt) setBlobFmt({ ...DEFAULT_FMT_PREFS, ...loaded.fmt });
    });
    return () => {
      cancelled = true;
    };
  }, [live, budgetId, storage]);
  const currentFmt = live ? fmt : blobFmt;

  /**
   * Live target: the budgetUi slice (state/budgetSettings persists it). Other
   * budgets: only their saved blob.
   */
  const applyFmt = (patch: Partial<FmtPrefs>) => {
    if (live) {
      dispatch(setFmtPrefs(patch));
      return;
    }
    setBlobFmt((prev) => ({ ...prev, ...patch }));
    if (budgetId) void saveBudgetSettingsPatch(storage, budgetId, { fmt: patch });
  };
  const rename = () => {
    const name = planName.trim();
    if (!budgetId || !name) return;
    setError(null);
    setSaved(false);
    renameBudget({ id: budgetId, name })
      .unwrap()
      .then(() => setSaved(true))
      .catch((err) => setError(apiErrorMessage(err)));
  };

  return (
    <>
      <Text style={s.sectionLabel}>PLAN NAME</Text>
      <TextInput
        value={planName}
        onChangeText={setPlanName}
        placeholder="Budget name"
        placeholderTextColor="#5f6878"
        onSubmitEditing={rename}
        style={s.input}
        accessibilityLabel="Budget name"
      />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
      {saved ? <Text style={s.savedText}>Saved.</Text> : null}
      <MenuRow label="Rename Budget" emphasized onPress={rename} />

      <Text style={s.sectionLabel}>CURRENCY</Text>
      <Seg<FmtCurrency>
        options={[
          { value: 'BRL', label: 'R$' },
          { value: 'USD', label: 'US$' },
        ]}
        value={currentFmt.currency}
        onChange={(currency) => {
          applyFmt({ currency });
        }}
      />
      <Text style={s.sectionLabel}>SYMBOL PLACEMENT</Text>
      <Seg<FmtPlacement>
        options={[
          { value: 'before', label: 'R$ 1.314,51' },
          { value: 'after', label: '1.314,51 R$' },
          { value: 'hidden', label: '1.314,51' },
        ]}
        value={currentFmt.currencyPlacement}
        onChange={(currencyPlacement) => {
          applyFmt({ currencyPlacement });
        }}
      />
      <Text style={s.sectionLabel}>NUMBER FORMAT</Text>
      <Seg<FmtNumberLocale>
        options={[
          { value: 'pt-BR', label: '1.314,51' },
          { value: 'en-US', label: '1,314.51' },
        ]}
        value={currentFmt.numberLocale}
        onChange={(numberLocale) => {
          applyFmt({ numberLocale });
        }}
      />
      <Text style={s.sectionLabel}>DATE FORMAT</Text>
      <Seg<FmtDateFormat>
        options={[
          { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
          { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
        ]}
        value={currentFmt.dateFormat}
        onChange={(dateFormat) => {
          applyFmt({ dateFormat });
        }}
      />
      <Text style={s.preview}>
        {fmtPreviewText(currentFmt, masked)}
      </Text>

      <Text style={s.sectionLabel}>MANAGE BUDGET</Text>
      {budgetId ? (
        <BudgetManageSection budgetId={budgetId} />
      ) : (
        <Text style={s.hint}>Switch to a budget first.</Text>
      )}
    </>
  );
}
