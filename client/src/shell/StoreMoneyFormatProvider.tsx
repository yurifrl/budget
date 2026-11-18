/** Provides `useMoneyFormat()` (ui) from the budgetUi slice; mounted inside the redux Provider. */
import type { ReactNode } from 'react';

import { useStoreMoneyFormat } from '@/state/useDisplayPrefs';
import { MoneyFormatProvider } from '@/ui/moneyFormat';

export function StoreMoneyFormatProvider({ children }: { children: ReactNode }) {
  return <MoneyFormatProvider value={useStoreMoneyFormat()}>{children}</MoneyFormatProvider>;
}
