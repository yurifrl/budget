import { getHealth, loginUrl } from './api';
import { usePolled, useHashPath } from './hooks';
import { t } from './i18n';
import { LanguageSelect } from './LanguageSelect';
import { FeaturesPage } from './pages/Features';
import { RunDetailPage } from './pages/RunDetail';
import { RunsPage } from './pages/Runs';
import { rich } from './rich';
import { UsersPage } from './pages/Users';
import { describeError } from './users.logic';

export function App() {
  const path = useHashPath();
  const health = usePolled(getHealth, []);
  const detail = /^\/runs\/([0-9a-f-]{36})$/i.exec(path);

  const status = health.error?.status;
  if (status === 401) {
    return (
      <Shell path={path}>
        <div className="notice">
          <h2>{t('auth.signInTitle')}</h2>
          <p>{rich(t('auth.signInBody', { url: loginUrl() }), { link: (c) => <a href={loginUrl()}>{c}</a> })}</p>
        </div>
      </Shell>
    );
  }
  if (status === 403) {
    return (
      <Shell path={path}>
        <div className="notice">
          <h2>{t('auth.notAdminTitle')}</h2>
          <p>{t('auth.notAdminBody')}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell path={path}>
      {health.error && (
        <div className="banner error">
          {health.error.status === 'network' ? describeError(health.error) : t('banner.unreachable', { message: describeError(health.error) })}
        </div>
      )}
      {health.data && !health.data.temporal.up && (
        <div className="banner warn">
          {rich(
            t('banner.schedulerDown', {
              reason: health.data.temporal.reason ?? t('banner.unknownReason'),
              count: health.data.queued,
            }),
            { b: (c) => <strong>{c}</strong> },
          )}
        </div>
      )}
      {health.data?.temporal.up && (
        <div className="banner ok">
          {rich(t('banner.schedulerUp', { count: health.data.queued, instance: health.data.instance_id }), {
            code: (c) => <code>{c}</code>,
          })}
        </div>
      )}
      {path.startsWith('/users') ? (
        <UsersPage />
      ) : path.startsWith('/features') ? (
        <FeaturesPage path={path} />
      ) : detail ? (
        <RunDetailPage id={detail[1]} uiUrl={health.data?.ui_url ?? null} />
      ) : (
        <RunsPage />
      )}
    </Shell>
  );
}

function Shell({ children, path = '/' }: { children: React.ReactNode; path?: string }) {
  const users = path.startsWith('/users');
  const features = path.startsWith('/features');
  return (
    <div className="shell">
      <header>
        <a href="#/" className="brand">
          {t('app.title')}
        </a>
        <nav>
          <a href="#/" className={users || features ? '' : 'active'}>
            {t('nav.jobs')}
          </a>
          <a href="#/users" className={users ? 'active' : ''}>
            {t('nav.users')}
          </a>
          <a href="#/features" className={features ? 'active' : ''}>
            {t('nav.features')}
          </a>
        </nav>
        <LanguageSelect />
      </header>
      <main>{children}</main>
    </div>
  );
}
