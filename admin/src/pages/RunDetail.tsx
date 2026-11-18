import { useState } from 'react';

import { cancelRun, getRun, retryRun } from '../api';
import { duration, fmt, StatusBadge } from '../badge';
import { usePolled } from '../hooks';
import { LEVELS } from '../types';

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
  if (!data) return <p className="muted">Loading…</p>;
  const { run, attempts, logs } = data;
  const shownLogs = level ? logs.filter((l) => LEVELS.indexOf(l.level) >= LEVELS.indexOf(level as (typeof LEVELS)[number])) : logs;
  const temporalLink =
    uiUrl && run.temporal_workflow_id
      ? `${uiUrl.replace(/\/+$/, '')}/namespaces/default/workflows/${encodeURIComponent(run.temporal_workflow_id)}`
      : null;

  return (
    <>
      <p>
        <a href="#/">← All runs</a>
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
              Retry
            </button>
          )}
          {(run.status === 'queued' || run.status === 'running') && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Cancel this run?')) void act(() => cancelRun(run.id));
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      {actionError && <div className="banner error">{actionError}</div>}

      <dl>
        <dt>Run id</dt>
        <dd className="mono">{run.id}</dd>
        <dt>Subject</dt>
        <dd className="mono">{run.subject_key}</dd>
        <dt>Instance / tenant</dt>
        <dd>
          {run.instance_id} / <span className="mono">{run.tenant_id ?? '—'}</span>
        </dd>
        <dt>Created / started / finished</dt>
        <dd>
          {fmt(run.created_at)} / {fmt(run.started_at)} / {fmt(run.finished_at)} ({duration(run.started_at, run.finished_at)})
        </dd>
        <dt>Requested by</dt>
        <dd>{run.requested_by ?? '—'}</dd>
        {run.retry_of && (
          <>
            <dt>Retry of</dt>
            <dd>
              <a href={`#/runs/${run.retry_of}`} className="mono">
                {run.retry_of}
              </a>
            </dd>
          </>
        )}
        {run.temporal_workflow_id && (
          <>
            <dt>Workflow</dt>
            <dd>
              <span className="mono">{run.temporal_workflow_id}</span>{' '}
              {temporalLink && (
                <a href={temporalLink} target="_blank" rel="noreferrer">
                  Open in Temporal UI ↗
                </a>
              )}
            </dd>
          </>
        )}
        {run.error_message && (
          <>
            <dt>Error</dt>
            <dd className="err">{run.error_message}</dd>
          </>
        )}
        <dt>Input</dt>
        <dd>
          <pre>{JSON.stringify(run.input, null, 2)}</pre>
        </dd>
        {run.result != null && (
          <>
            <dt>Result</dt>
            <dd>
              <pre>{JSON.stringify(run.result, null, 2)}</pre>
            </dd>
          </>
        )}
      </dl>

      <h3>Attempts</h3>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Status</th>
            <th>Worker</th>
            <th>Started</th>
            <th>Finished</th>
            <th>Error</th>
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
                    <pre>{a.error_stack ?? 'no stack recorded'}</pre>
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
                No attempts yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3>
        Logs{' '}
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">all levels</option>
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
            <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
            <span className="lvl">{l.level}</span>
            <span>#{l.attempt_no}</span>
            <span className="msg">
              {l.message}
              {l.fields && <span className="muted"> {JSON.stringify(l.fields)}</span>}
            </span>
          </div>
        ))}
        {shownLogs.length === 0 && <p className="muted">No log lines.</p>}
      </div>
    </>
  );
}
