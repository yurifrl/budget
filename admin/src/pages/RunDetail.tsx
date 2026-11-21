import { useState } from 'react';

import { tCommon } from '@shared/i18n/common';
import { getLocale } from '@shared/i18n';

import { cancelRun, getRun, retryRun } from '../api';
import { duration, fmt, StatusBadge } from '../badge';
import { usePolled } from '../hooks';
import { LEVELS } from '../types';
import { t } from './runs/i18n';

export function RunDetailPage({ id, uiUrl }: { id: string; uiUrl: string | null }) {
  const { data, error, reload } = usePolled(() => getRun(id), [id]);
  const [level, setLevel] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, after?: (r: never) => void) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await fn();
      after?.(r as never);
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <div className="banner error">{error.message}</div>;
  if (!data) return <p className="muted">{tCommon('loading')}</p>;
  const { run, attempts, logs } = data;
  const shownLogs = level ? logs.filter((l) => LEVELS.indexOf(l.level) >= LEVELS.indexOf(level as (typeof LEVELS)[number])) : logs;
  const temporalLink =
    uiUrl && run.temporal_workflow_id
      ? `${uiUrl.replace(/\/+$/, '')}/namespaces/default/workflows/${encodeURIComponent(run.temporal_workflow_id)}`
      : null;

  return (
    <>
      <p>
        <a href="#/">{t('detail.back')}</a>
      </p>
      <div className="head">
        <h2>
          {run.job_type} <StatusBadge status={run.status} />
        </h2>
        <div className="actions">
          {(run.status === 'failed' || run.status === 'cancelled') && (
            <button
              disabled={busy}
              onClick={() =>
                void act(
                  () => retryRun(run.id),
                  ((r: { run: { id: string } }) => {
                    window.location.hash = `#/runs/${r.run.id}`;
                  }) as never,
                )
              }
            >
              {t('detail.retry')}
            </button>
          )}
          {(run.status === 'queued' || run.status === 'running') && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('detail.confirmCancel'))) void act(() => cancelRun(run.id));
              }}
            >
              {tCommon('cancel')}
            </button>
          )}
        </div>
      </div>
      {actionError && <div className="banner error">{actionError}</div>}

      <dl>
        <dt>{t('detail.runId')}</dt>
        <dd className="mono">{run.id}</dd>
        <dt>{t('col.subject')}</dt>
        <dd className="mono">{run.subject_key}</dd>
        <dt>{t('detail.instanceTenant')}</dt>
        <dd>
          {run.instance_id} / <span className="mono">{run.tenant_id ?? '—'}</span>
        </dd>
        <dt>{t('detail.times')}</dt>
        <dd>
          {fmt(run.created_at)} / {fmt(run.started_at)} / {fmt(run.finished_at)} ({duration(run.started_at, run.finished_at)})
        </dd>
        <dt>{t('detail.requestedBy')}</dt>
        <dd>{run.requested_by ?? '—'}</dd>
        {run.retry_of && (
          <>
            <dt>{t('detail.retryOf')}</dt>
            <dd>
              <a href={`#/runs/${run.retry_of}`} className="mono">
                {run.retry_of}
              </a>
            </dd>
          </>
        )}
        {run.temporal_workflow_id && (
          <>
            <dt>{t('detail.workflow')}</dt>
            <dd>
              <span className="mono">{run.temporal_workflow_id}</span>{' '}
              {temporalLink && (
                <a href={temporalLink} target="_blank" rel="noreferrer">
                  {t('detail.openTemporal')}
                </a>
              )}
            </dd>
          </>
        )}
        {run.error_message && (
          <>
            <dt>{t('col.error')}</dt>
            <dd className="err">{run.error_message}</dd>
          </>
        )}
        <dt>{t('detail.input')}</dt>
        <dd>
          <pre>{JSON.stringify(run.input, null, 2)}</pre>
        </dd>
        {run.result != null && (
          <>
            <dt>{t('detail.result')}</dt>
            <dd>
              <pre>{JSON.stringify(run.result, null, 2)}</pre>
            </dd>
          </>
        )}
      </dl>

      <h3>{t('detail.attempts')}</h3>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>{t('col.status')}</th>
            <th>{t('col.worker')}</th>
            <th>{t('col.started')}</th>
            <th>{t('col.finished')}</th>
            <th>{t('col.error')}</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a) => (
            <tr key={a.attempt_no}>
              <td>{a.attempt_no}</td>
              <td>
                <StatusBadge status={a.status} />
              </td>
              <td className="mono">{a.worker_id ?? '—'}</td>
              <td>{fmt(a.started_at)}</td>
              <td>{fmt(a.finished_at)}</td>
              <td>
                {a.error_message ? (
                  <details>
                    <summary>
                      {a.error_code ? `[${a.error_code}] ` : ''}
                      {a.error_message}
                    </summary>
                    <pre>{a.error_stack ?? t('detail.noStack')}</pre>
                  </details>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
          {attempts.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {t('detail.noAttempts')}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3>
        {t('detail.logs')}{' '}
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">{t('detail.allLevels')}</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}+
            </option>
          ))}
        </select>
      </h3>
      <div className="logs">
        {shownLogs.map((l) => (
          <div key={l.id} className={`log ${l.level}`}>
            <span className="ts">{new Date(l.ts).toLocaleTimeString(getLocale())}</span>
            <span className="lvl">{l.level}</span>
            <span>#{l.attempt_no}</span>
            <span className="msg">
              {l.message}
              {l.fields && <span className="muted"> {JSON.stringify(l.fields)}</span>}
            </span>
          </div>
        ))}
        {shownLogs.length === 0 && <p className="muted">{t('detail.noLogs')}</p>}
      </div>
    </>
  );
}
