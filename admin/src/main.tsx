import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { getLocale, resolveLocale, setLocale, setPseudoLocale } from '@shared/i18n';

import { App } from './App';
import { loadConfig } from './api';
import './styles.css';

// Language: the browser's, no setting (the admin is an operator tool). `?lang=xa` = dev pseudo-locale.
setLocale(resolveLocale(navigator.languages));
setPseudoLocale(new URLSearchParams(window.location.search).get('lang') === 'xa');
document.documentElement.lang = getLocale();

void loadConfig().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
