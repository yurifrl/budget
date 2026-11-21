import { useMemo, useState } from 'react';

import {
  clearFeatureEveryone,
  clearFeatureUser,
  listFeatures,
  listUsers,
  setFeatureEveryone,
  type AdminFeature,
  type AdminUser,
} from '../api';
import { FeatureToggle, UserFeaturesDropdown, useFeatureActions } from '../featureControls';
import {
  changedLabel,
  everyoneState,
  featureDescription,
  featureKeyFromPath,
  groupFeatures,
  groupLabel,
  onOff,
  overridesLabel,
  shownLabel,
  userState,
} from '../features.logic';
import { usePolled } from '../hooks';
import { rich } from '../rich';
import { t } from './features/i18n';
import { label, ROLE_LABEL, USER_STATUS_LABEL } from '../enumLabels';
import { describeError, matchesFilter } from '../users.logic';

const msg = describeError;
const detailHref = (key: string) => `#/features/${encodeURIComponent(key)}`;

/**
 * `#/features`: every feature under its group, filterable, each with its
 * "Everyone" switch. `#/features/<key>`: one feature and its users (who is
 * overridden, who inherits).
 */
export function FeaturesPage({ path }: { path: string }) {
  const features = usePolled(listFeatures, [], 15000);
  const key = featureKeyFromPath(path);
  const feature = key ? (features.data?.find((f) => f.key === key) ?? null) : null;

  return (
    <>
      {features.error && <div className="banner error">{msg(features.error)}</div>}
      {key === null && features.data && <FeatureList features={features.data} reload={features.reload} />}
      {key !== null && features.data && !feature && (
        <div className="notice">
          <p>{rich(t('page.notFound', { key }), { code: (c) => <code>{c}</code> })}</p>
          <a href="#/features">{t('page.all')}</a>
        </div>
      )}
      {feature && features.data && <FeatureDetail feature={feature} features={features.data} reload={features.reload} />}
    </>
  );
}

function EveryoneToggle({ feature, busy, run }: { feature: AdminFeature; busy: ReadonlySet<string>; run: ReturnType<typeof useFeatureActions>['run'] }) {
  const key = feature.key;
  return (
    <FeatureToggle
      state={everyoneState(feature)}
      name={t('toggle.everyoneName', { key })}
      clearLabel={t('action.useDefault')}
      busy={busy.has(key)}
      now={Date.now()}
      onSet={(value) => void run(key, () => setFeatureEveryone(key, value))}
      onClear={() => void run(key, () => clearFeatureEveryone(key))}
    />
  );
}

function FeatureList({ features, reload }: { features: AdminFeature[]; reload: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const { busy, notice, run } = useFeatureActions(reload);
  const groups = useMemo(() => groupFeatures(features, q), [features, q]);
  const shown = groups.reduce((n, g) => n + g.features.length, 0);

  if (features.length === 0) return <div className="notice">{t('page.noneInCode')}</div>;
  return (
    <>
      <div className="toolbar">
        <input
          className="grow"
          type="search"
          placeholder={t('popover.filterPlaceholder')}
          aria-label={t('popover.filterLabel')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="muted">{shownLabel(shown, features.length, q)}</span>
      </div>
      {notice && <div className="banner error">{notice}</div>}
      <div className="table-wrap">
        <table className="feature-list">
          <thead>
            <tr>
              <th>{t('col.feature')}</th>
              <th>{t('col.default')}</th>
              <th>{t('col.everyone')}</th>
              <th>{t('col.users')}</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.group}>
              <tr className="group-row">
                <th colSpan={4} scope="rowgroup">
                  {groupLabel(g.group)} <span className="muted">({g.features.length})</span>
                </th>
              </tr>
              {g.features.map((f) => (
                <tr key={f.key}>
                  <td>
                    <a href={detailHref(f.key)}>
                      <code>{f.key}</code>
                    </a>
                    <div className="muted sub">{featureDescription(f)}</div>
                  </td>
                  <td>
                    <span className={`badge ${f.default ? 'active' : 'disabled'}`}>{onOff(f.default)}</span>
                  </td>
                  <td>
                    <EveryoneToggle feature={f} busy={busy} run={run} />
                  </td>
                  <td className="nowrap">
                    <a href={detailHref(f.key)}>{overridesLabel(f)}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          {groups.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={4} className="muted">
                  {t('popover.noMatch')}
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </>
  );
}

function FeatureDetail({ feature, features, reload }: { feature: AdminFeature; features: AdminFeature[]; reload: () => Promise<void> }) {
  const users = usePolled(listUsers, [], 15000);
  const [q, setQ] = useState('');
  const [onlyOverridden, setOnlyOverridden] = useState(false);
  const { busy, notice, run } = useFeatureActions(reload);
  const now = Date.now();
  const key = feature.key;
  const overridden = useMemo(() => new Set(feature.overrides.map((o) => o.user_id)), [feature.overrides]);
  const rows = useMemo(
    () => (users.data ?? []).filter((u: AdminUser) => matchesFilter(u, q) && (!onlyOverridden || overridden.has(u.id))),
    [users.data, q, onlyOverridden, overridden],
  );
  // Overrides of users the list does not show (synthetic rows, people without e-mail): still visible, still removable.
  const unlisted = useMemo(() => {
    if (!users.data) return [];
    const listed = new Set(users.data.map((u) => u.id));
    return feature.overrides.filter((o) => !listed.has(o.user_id));
  }, [users.data, feature.overrides]);

  return (
    <>
      <p className="crumbs">
        <a href="#/features">{t('page.all')}</a> / {groupLabel(feature.group)}
      </p>
      <section className="feature-card">
        <h2>
          <code>{key}</code> <span className="badge">{groupLabel(feature.group)}</span>
        </h2>
        <p>{featureDescription(feature)}</p>
        <p className="muted sub">
          {rich(t('detail.defaultInCode', { state: onOff(feature.default) }), { b: (c) => <strong>{c}</strong> })}
        </p>
        <div className="everyone-row" data-testid="everyone-row">
          <strong>{t('detail.everyone')}</strong>
          <EveryoneToggle feature={feature} busy={busy} run={run} />
        </div>
      </section>
      {users.error && <div className="banner error">{msg(users.error)}</div>}
      {notice && <div className="banner error">{notice}</div>}
      <div className="toolbar">
        <input
          className="grow"
          type="search"
          placeholder={t('detail.filterPlaceholder')}
          aria-label={t('detail.filterLabel')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={onlyOverridden} onChange={(e) => setOnlyOverridden(e.target.checked)} /> {t('detail.overriddenOnly')}
        </label>
        <span className="muted">{overridesLabel(feature)}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('userCol.email')}</th>
              <th>{t('userCol.name')}</th>
              <th>{t('userCol.status')}</th>
              <th>{t('userCol.thisFeature')}</th>
              <th>{t('userCol.features')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const state = userState(feature, u.id);
              return (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${u.role}`}>{label(ROLE_LABEL, u.role)}</span>{' '}
                    <span className={`badge ${u.status}`}>{label(USER_STATUS_LABEL, u.status)}</span>
                  </td>
                  <td>
                    <span className={`badge ${state.value ? 'active' : 'disabled'}`}>{onOff(state.value)}</span>{' '}
                    <span className={`badge ${state.stored ? 'overridden' : 'inherited'}`}>{state.label}</span>
                    {state.stored && <div className="muted sub">{changedLabel(state.stored, now)}</div>}
                  </td>
                  <td>
                    <UserFeaturesDropdown user={u} features={features} reload={reload} initialFilter={key} />
                  </td>
                </tr>
              );
            })}
            {!q.trim() &&
              unlisted.map((o) => {
                const id = `${key}:${o.user_id}`;
                const state = userState(feature, o.user_id);
                return (
                  <tr key={o.user_id}>
                    <td colSpan={3} className="muted">
                      {rich(t('detail.unlisted', { id: o.user_id }), { code: (c) => <code>{c}</code> })}
                    </td>
                    <td>
                      <span className={`badge ${state.value ? 'active' : 'disabled'}`}>{onOff(state.value)}</span>{' '}
                      <span className="badge overridden">{state.label}</span>
                      <div className="muted sub">{changedLabel(state.stored, now)}</div>
                    </td>
                    <td>
                      <button className="small" disabled={busy.has(id)} onClick={() => void run(id, () => clearFeatureUser(key, o.user_id))}>
                        {t('action.inherit')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            {users.data && rows.length === 0 && (unlisted.length === 0 || !!q.trim()) && (
              <tr>
                <td colSpan={5} className="muted">
                  {users.data.length === 0 ? t('detail.noUsers') : onlyOverridden && !q.trim() ? t('detail.noOverrides') : t('detail.noUserMatch')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
