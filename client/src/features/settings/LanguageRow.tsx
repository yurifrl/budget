import { Text } from 'react-native';

import type { Locale } from '@shared/i18n';
import { useLanguagePreference } from '@/platform/locale/useLocale';
import type { LanguagePreference } from '@/platform/locale/locale';

import { t } from './i18n';
import { Seg } from './menuRows';
import { s } from './styles';

/** Language: follow the device, or pick English or Brazilian Portuguese. Device-level, not per budget. */
export function LanguageRow() {
  const { preference, setPreference } = useLanguagePreference();
  const options: { value: LanguagePreference; label: string }[] = [
    { value: 'system', label: t('language.option.system') },
    { value: 'en' satisfies Locale, label: t('language.option.en') },
    { value: 'pt-BR' satisfies Locale, label: t('language.option.ptBR') },
  ];
  return (
    <>
      <Text style={s.sectionLabel}>{t('language.title')}</Text>
      <Seg<LanguagePreference> options={options} value={preference} onChange={(v) => void setPreference(v)} />
    </>
  );
}
