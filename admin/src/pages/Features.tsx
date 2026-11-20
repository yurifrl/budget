import { useMemo, useState } from 'react';

import {
  ApiError,
  clearFeatureEveryone,
  clearFeatureUser,
  listFeatures,
  listUsers,
  setFeatureEveryone,
  setFeatureUser,
  type AdminFeature,
  type AdminUser,
} from '../api';
import { FeatureToggle, useFeatureActions } from '../featureControls';
import { everyoneState, onOff, pickFeature, userState } from '../features.logic';
import { usePolled } from '../hooks';
import { errorMessage, matchesFilter } from '../users.logic';

const msg = (e: ApiError) => errorMessage(e.code, e.message, e.status);

/** Pick a feature: its switch for everyone, then every user with their own switch (inherited or overridden). */
export function FeaturesPage({ path }: { path: string }) {
  const features = usePolled(listFeatures, [], 15000);
  const users = usePolled(listUsers, [], 15000);
  const feature = pickFeature(features.data ?? [], path);

  return (
    <>
      {features.error && <div className="banner error">{msg(features.error)}</div>}
      {users.error && <div className="banner error">{msg(users.error)}</div>}
      {features.data && features.data.length === 0 && <div className="notice">No features are defined in the code.</div>}
      {features.data && features.data.length > 0 && (
        <div className="feature-picker" role="tablist" aria-label="Features">
          {features.data.map((f) => (
            <a
              key={f.key}
              role="tab"
              aria-selected={f.key === feature?.key}
              href={`#/features/${encodeURIComponent(f.key)}`}
              className={f.key === feature?.key ? 'active' : ''}
            >
              <code>{f.key}</code>
              <span className={`badge ${everyoneState(f).value ? 'active' : 'disabled'}`}>{onOff(everyoneState(f).value)}</span>
            </a>
          ))}
        </div>
      )}
      {feature && <FeatureDetail feature={feature} users={users.data} reload={features.reload} />}
    </>
  );
}

function FeatureDetail({ feature, users, reload }: { feature: AdminFeature; users: AdminUser[] | null; reload: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const { busy, notice, run } = useFeatureActions(reload);
  const now = Date.now();
  const key = feature.key;
  const rows = useMemo(() => (users ?? []).filter((u) => matchesFilter(u, q)), [users, q]);
  // Overrides of users the list does not show (synthetic rows, people without e-mail): still visible, still removable.
  const unlisted = useMemo(() => {
    if (!users) return [];
    const listed = new Set(users.map((u) => u.id));
    return feature.overrides.filter((o) => !listed.has(o.user_id));
  }, [users, feature.overrides]);

  return (
    <>
      <section className="feature-card">
        <h2>
          <code>{key}</code>
        </h2>
        <p>{feature.description}</p>
        <p className="muted sub">
          Default in code: <strong>{onOff(feature.default)}</strong>. Order: a user's own value, else the value for everyone, else the default.
        </p>
        <div className="everyone-row" data-testid="everyone-row">
          <strong>Everyone</strong>
          <FeatureToggle
            state={everyoneState(feature)}
            name={`${key} for everyone`}
            clearLabel="Use default"
            busy={busy.has(key)}
            now={now}
            onSet={(value) => void run(key, () => setFeatureEveryone(key, value))}
            onClear={() => void run(key, () => clearFeatureEveryone(key))}
          />
        </div>
      </section>
      {notice && <div className="banner error">{notice}</div>}
      <div className="toolbar">
        <input className="grow" placeholder="Filter users by e-mail or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted">
          {feature.overrides.length} overridden, {Math.max(0, (users?.length ?? 0) - (feature.overrides.length - unlisted.length))} inherited
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>E-mail</th>
              <th>Name</th>
              <th>Status</th>
              <th>{key}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const id = `${key}:${u.id}`;
              return (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name ?? <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge ${u.role}`}>{u.role}</span> <span className={`badge ${u.status}`}>{u.status}</span>
                  </td>
                  <td>
                    <FeatureToggle
                      state={userState(feature, u.id)}
                      name={`${key} for ${u.email}`}
                      clearLabel="Inherit"
                      busy={busy.has(id)}
                      now={now}
                      onSet={(value) => void run(id, () => setFeatureUser(key, u.id, value))}
                      onClear={() => void run(id, () => clearFeatureUser(key, u.id))}
                    />
                  </td>
                </tr>
              );
            })}
            {!q.trim() &&
              unlisted.map((o) => {
                const id = `${key}:${o.user_id}`;
                return (
                  <tr key={o.user_id}>
                    <td colSpan={3} className="muted">
                      A user not in the Users list (<code>{o.user_id}</code>)
                    </td>
                    <td>
                      <FeatureToggle
                        state={userState(feature, o.user_id)}
                        name={`${key} for user ${o.user_id}`}
                        clearLabel="Inherit"
                        busy={busy.has(id)}
                        now={now}
                        onSet={(value) => void run(id, () => setFeatureUser(key, o.user_id, value))}
                        onClear={() => void run(id, () => clearFeatureUser(key, o.user_id))}
                      />
                    </td>
                  </tr>
                );
              })}
            {users && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {users.length === 0 ? 'No users.' : 'No user matches the filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
