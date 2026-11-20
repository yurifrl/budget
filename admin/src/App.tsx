import { getHealth, loginUrl } from './api';
import { usePolled, useHashPath } from './hooks';
import { FeaturesPage } from './pages/Features';
import { RunDetailPage } from './pages/RunDetail';
import { RunsPage } from './pages/Runs';
import { UsersPage } from './pages/Users';

export function App() {
  const path = useHashPath();
  const health = usePolled(getHealth, []);
  const detail = /^\/runs\/([0-9a-f-]{36})$/i.exec(path);

  const status = health.error?.status;
  if (status === 401) {
    return (
      <Shell path={path}>
        <div className="notice">
          <h2>Sign in required</h2>
          <p>
            Sign in at <a href={loginUrl()}>{loginUrl()}</a> with an admin account, then reload this page. Signing in at the
            app (with any method: password, Google or Access) also works, since the session cookie is shared.
          </p>
        </div>
      </Shell>
    );
  }
  if (status === 403) {
    return (
      <Shell path={path}>
        <div className="notice">
          <h2>Not an admin</h2>
          <p>Your account is not an admin.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell path={path}>
      {health.error && <div className="banner error">Cannot reach the API: {health.error.message}</div>}
      {health.data && !health.data.temporal.up && (
        <div className="banner warn">
          Scheduler (Temporal) unavailable — runs stay queued: {health.data.temporal.reason ?? 'unknown reason'}
          <strong> · {health.data.queued} queued</strong>
        </div>
      )}
      {health.data?.temporal.up && (
        <div className="banner ok">
          Scheduler up · {health.data.queued} queued · instance <code>{health.data.instance_id}</code>
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
          Budget admin
        </a>
        <nav>
          <a href="#/" className={users || features ? '' : 'active'}>
            Jobs
          </a>
          <a href="#/users" className={users ? 'active' : ''}>
            Users
          </a>
          <a href="#/features" className={features ? 'active' : ''}>
            Features
          </a>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
