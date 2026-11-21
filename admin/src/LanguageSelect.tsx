import { LOCALE_NAMES } from '@shared/i18n';

import { t } from './i18n';
import { LANGUAGE_PREFERENCES, parseLanguagePreference, readLanguagePreference, saveLanguagePreference } from './language';

/** System / English / Português (Brasil). Stored in localStorage; a change reloads the page. */
export function LanguageSelect() {
  return (
    <select
      style={{ marginLeft: 'auto' }}
      aria-label={t('language.label')}
      value={readLanguagePreference()}
      onChange={(e) => saveLanguagePreference(parseLanguagePreference(e.target.value))}
    >
      {LANGUAGE_PREFERENCES.map((pref) => (
        <option key={pref} value={pref}>
          {pref === 'system' ? t('language.system') : LOCALE_NAMES[pref]}
        </option>
      ))}
    </select>
  );
}
