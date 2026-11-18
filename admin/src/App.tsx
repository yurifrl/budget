import { getHealth, loginUrl } from './api';
import { usePolled, useHashPath } from './hooks';
import { RunDetailPage } from './pages/RunDetail';
import { RunsPage } from './pages/Runs';

export function App() {
  const path = useHashPath();
  const health = usePolled(getHealth, []);
  const detail = /^\/runs\/([0-9a-f-]{36})$/i.exec(path);

  const status = health.error?.status;
  if (status === 401) {
    return (
      <Shell>
        <div className="notice">
          <h2>Sign in required</h2>
          <p>
            Sign in at <a href={loginUrl()}>{loginUrl()}</a> with an admin account, then reload this page.
          </p>
        </div>
      </Shell>
    );
  }
  if (status === 403) {
    return (
      <Shell>
        <div className="notice">
          <h2>Not an admin</h2>
          <p>Your account is not an admin.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
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
      {detail ? <RunDetailPage id={detail[1]} uiUrl={health.data?.ui_url ?? null} /> : <RunsPage />}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <header>
        <a href="#/" className="brand">
          Budget admin <span>jobs</span>
        </a>
      </header>
      <main>{children}</main>
    </div>
  );
}
