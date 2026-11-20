import { useState } from 'react';

import { ApiError, clearFeatureUser, setFeatureUser, type AdminFeature } from './api';
import { changedLabel, userState, type ToggleState } from './features.logic';
import { errorMessage } from './users.logic';

const msg = (e: unknown) => (e instanceof ApiError ? errorMessage(e.code, e.message, e.status) : String(e));

/** Runs one feature write at a time per id (`<feature>` or `<feature>:<user>`), then reloads; keeps the last error. */
export function useFeatureActions(reload: () => Promise<void> | void) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (id: string, write: () => Promise<unknown>) => {
    if (busy.has(id)) return;
    setNotice(null);
    setBusy((b) => new Set(b).add(id));
    try {
      await write();
    } catch (e) {
      setNotice(msg(e));
    }
    await reload();
    setBusy((b) => {
      const n = new Set(b);
      n.delete(id);
      return n;
    });
  };
  return { busy, notice, run };
}

/** An on/off switch, where its value comes from, who set it and when, and the button that removes the stored value. */
export function FeatureToggle(props: {
  state: ToggleState;
  /** Accessible name of the switch, e.g. "shared-pluggy-key for ana@x.test". */
  name: string;
  /** Text of the button that removes the stored value ("Use default" / "Inherit"). */
  clearLabel: string;
  busy: boolean;
  now: number;
  onSet: (value: boolean) => void;
  onClear: () => void;
}) {
  const { state, busy } = props;
  return (
    <div className="feature-toggle">
      <label className="switch">
        <input type="checkbox" role="switch" aria-label={props.name} checked={state.value} disabled={busy} onChange={(e) => props.onSet(e.target.checked)} />
        <span className="track" aria-hidden="true" />
        <span className="switch-text">{state.value ? 'On' : 'Off'}</span>
      </label>
      <span className={`badge ${state.stored ? 'overridden' : 'inherited'}`}>{state.label}</span>
      {state.stored && <span className="muted sub">{changedLabel(state.stored, props.now)}</span>}
      {state.stored && (
        <button className="small" disabled={busy} onClick={props.onClear}>
          {props.clearLabel}
        </button>
      )}
    </div>
  );
}

/** Every feature for one user (the expanded row of the Users page). */
export function UserFeatures(props: { user: { id: string; email: string }; features: readonly AdminFeature[]; reload: () => Promise<void> | void }) {
  const { user, features } = props;
  const { busy, notice, run } = useFeatureActions(props.reload);
  const now = Date.now();
  if (features.length === 0) return <div className="muted">No features are defined.</div>;
  return (
    <div className="user-features" data-testid={`user-features-${user.email}`}>
      {notice && <div className="err">{notice}</div>}
      {features.map((f) => {
        const id = `${f.key}:${user.id}`;
        return (
          <div className="user-feature" key={f.key}>
            <div className="user-feature-name">
              <a href={`#/features/${encodeURIComponent(f.key)}`}>
                <code>{f.key}</code>
              </a>
              <div className="muted sub">{f.description}</div>
            </div>
            <FeatureToggle
              state={userState(f, user.id)}
              name={`${f.key} for ${user.email}`}
              clearLabel="Inherit"
              busy={busy.has(id)}
              now={now}
              onSet={(value) => void run(id, () => setFeatureUser(f.key, user.id, value))}
              onClear={() => void run(id, () => clearFeatureUser(f.key, user.id))}
            />
          </div>
        );
      })}
    </div>
  );
}
