import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { loadConfig } from './api';
import { t } from './i18n';
import { initLocale } from './language';
import './styles.css';

// Language: the stored `app.language` preference, else the browser's; `?lang=xa` = dev pseudo-locale.
initLocale();

void loadConfig().then(() => {
  document.title = t('app.title');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
