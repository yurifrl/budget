import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, clearFeatureUser, setFeatureUser, type AdminFeature } from './api';
import { changedLabel, groupFeatures, popoverPlacement, shownLabel, userState, userSummary, type Placement, type ToggleState } from './features.logic';
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

/**
 * One user's features as a dropdown: a button with a short summary that opens
 * a popover listing every feature under its group heading, with a filter box
 * (focused on open). Each entry has its switch, inherited/overridden with who
 * and when, and "Inherit". Closes on Escape and on a click outside.
 */
export function UserFeaturesDropdown(props: {
  user: { id: string; email: string };
  /** null while the list is loading. */
  features: readonly AdminFeature[] | null;
  reload: () => Promise<void> | void;
  /** Filter text the popover opens with (the Features page opens it on its own feature). */
  initialFilter?: string;
}) {
  const { user, features } = props;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [place, setPlace] = useState<Placement | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const { busy, notice, run } = useFeatureActions(props.reload);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const position = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setPlace(popoverPlacement(r, { width: window.innerWidth, height: window.innerHeight }));
    };
    const outside = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    position();
    filterRef.current?.focus();
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, close]);

  const toggle = () => {
    if (open) return close(false);
    setQ(props.initialFilter ?? '');
    setPlace(null);
    setOpen(true);
  };

  const all = features ?? [];
  const groups = open ? groupFeatures(all, q) : [];
  const shown = groups.reduce((n, g) => n + g.features.length, 0);
  const now = Date.now();
  const listId = `features-of-${user.id}`;

  return (
    <span className="features-dropdown" ref={rootRef}>
      <button ref={buttonRef} className="dropdown-button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={!features} onClick={toggle}>
        {features ? userSummary(all, user.id).label : 'Loading'}
        <span className="caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          id={listId}
          className="features-popover"
          role="dialog"
          aria-label={`Features for ${user.email}`}
          data-testid={`features-popover-${user.email}`}
          style={place ? { ...place } : { visibility: 'hidden' }}
        >
          <div className="popover-head">
            <input
              ref={filterRef}
              className="grow"
              type="search"
              placeholder="Filter features by name, group or description"
              aria-label="Filter features"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <span className="muted sub">{shownLabel(shown, all.length, q)}</span>
          </div>
          <div className="muted sub popover-who">{user.email}</div>
          {notice && <div className="err popover-notice">{notice}</div>}
          <div className="popover-list">
            {groups.map((g) => (
              <section key={g.group} aria-label={g.group}>
                <h4>{g.group}</h4>
                {g.features.map((f) => {
                  const id = `${f.key}:${user.id}`;
                  return (
                    <div className="popover-feature" key={f.key}>
                      <div className="popover-feature-name">
                        <code>{f.key}</code>
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
              </section>
            ))}
            {groups.length === 0 && <div className="muted popover-empty">{all.length === 0 ? 'No features are defined.' : 'No feature matches the filter.'}</div>}
          </div>
        </div>
      )}
    </span>
  );
}
