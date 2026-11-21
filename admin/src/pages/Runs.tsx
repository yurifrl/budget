import { useState } from 'react';

import { listRuns } from '../api';
import { duration, fmt, StatusBadge } from '../badge';
import { usePolled } from '../hooks';
import { label, RUN_STATUS_LABEL } from '../enumLabels';
import { STATUSES } from '../types';
import { describeError } from '../users.logic';
import { t } from './runs/i18n';

const PAGE = 25;

export function RunsPage() {
  const [instance, setInstance] = useState('');
  const [tenant, setTenant] = useState('');
  const [jobType, setJobType] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, error } = usePolled(
    () =>
      listRuns({
        instance_id: instance || undefined,
        tenant_id: tenant || undefined,
        job_type: jobType || undefined,
        status: status || undefined,
        limit: PAGE,
        offset,
      }),
    [instance, tenant, jobType, status, offset],
  );
  const onFilter = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setOffset(0);
  };

  return (
    <>
      <div className="filters">
        <input placeholder={t('filter.instance')} value={instance} onChange={onFilter(setInstance)} />
        <input placeholder={t('filter.tenant')} value={tenant} onChange={onFilter(setTenant)} />
        <input placeholder={t('filter.jobType')} value={jobType} onChange={onFilter(setJobType)} />
        <select value={status} onChange={onFilter(setStatus)}>
          <option value="">{t('filter.anyStatus')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(RUN_STATUS_LABEL, s)}
            </option>
          ))}
        </select>
        <span className="muted">{t('filter.autoRefresh')}</span>
      </div>
      {error && <div className="banner error">{describeError(error)}</div>}
      <table>
        <thead>
          <tr>
            <th>{t('col.status')}</th>
            <th>{t('col.jobType')}</th>
            <th>{t('col.subject')}</th>
            <th>{t('col.instance')}</th>
            <th>{t('col.attempts')}</th>
            <th>{t('col.created')}</th>
            <th>{t('col.duration')}</th>
          </tr>
        </thead>
        <tbody>
          {data?.runs.map((r) => (
            <tr key={r.id}>
              <td>
                <StatusBadge status={r.status} />
              </td>
              <td>
                <a href={`#/runs/${r.id}`}>{r.job_type}</a>
                {r.retry_of && <span className="muted"> {t('list.retry')}</span>}
              </td>
              <td className="mono">{r.subject_key}</td>
              <td>{r.instance_id}</td>
              <td>{r.attempts}</td>
              <td>{fmt(r.created_at)}</td>
              <td>{duration(r.started_at, r.finished_at)}</td>
            </tr>
          ))}
          {data && data.runs.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                {t('list.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data && (
        <div className="pager">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            {t('pager.prev')}
          </button>
          <span>
            {t('pager.range', { from: data.total === 0 ? 0 : offset + 1, to: Math.min(offset + PAGE, data.total), total: data.total })}
          </span>
          <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
            {t('pager.next')}
          </button>
        </div>
      )}
    </>
  );
}
