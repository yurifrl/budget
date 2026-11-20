import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  createUser,
  deleteUser,
  getMe,
  listFeatures,
  listUsers,
  resetUserPassword,
  updateUser,
  type AdminUser,
  type AdminUserWithTempPassword,
} from '../api';
import { UserFeaturesDropdown } from '../featureControls';
import { usePolled } from '../hooks';
import { fmt } from '../badge';
import {
  errorMessage,
  lockLabel,
  matchesFilter,
  passwordState,
  relativeTime,
  selfLimits,
  signedInLabel,
  signInMethods,
} from '../users.logic';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: AdminUser }
  | { kind: 'delete'; user: AdminUser }
  | { kind: 'reset'; user: AdminUser }
  | { kind: 'secret'; result: AdminUserWithTempPassword; reason: 'created' | 'reset' };

const msg = (e: unknown) => (e instanceof ApiError ? errorMessage(e.code, e.message, e.status) : String(e));

export function UsersPage() {
  const users = usePolled(listUsers, [], 15000);
  const me = usePolled(getMe, [], 60000);
  const features = usePolled(listFeatures, [], 15000);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const now = Date.now();

  const rows = useMemo(() => (users.data ?? []).filter((u) => matchesFilter(u, q)), [users.data, q]);
  const meEmail = me.data?.email ?? null;

  const flip = async (u: AdminUser, patch: { role?: 'admin' | 'user'; status?: 'active' | 'disabled' }) => {
    if (busy.has(u.id)) return;
    setNotice(null);
    setBusy((b) => new Set(b).add(u.id));
    try {
      await updateUser({ id: u.id, ...patch });
    } catch (e) {
      setNotice(msg(e));
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(u.id);
        return n;
      });
    }
    void users.reload();
  };
  const open = (d: Dialog) => {
    setNotice(null);
    setDialog(d);
  };

  return (
    <>
      <div className="toolbar">
        <input className="grow" placeholder="Filter by e-mail or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" onClick={() => open({ kind: 'create' })}>
          Create user
        </button>
      </div>
      {users.error && <div className="banner error">{msg(users.error)}</div>}
      {features.error && <div className="banner error">Features: {msg(features.error)}</div>}
      {notice && <div className="banner error">{notice}</div>}
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>E-mail</th>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            <th>Sign-in</th>
            <th>Password</th>
            <th>Last seen</th>
            <th>Features</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const { isSelf, locked, hint } = selfLimits(u, meEmail);
            const methods = signInMethods(u);
            const pw = passwordState(u, now);
            const lock = lockLabel(u.locked_until, now);
            return (
              <tr key={u.id}>
                <td>
                  {u.email}
                  {isSelf && <span className="muted"> (you)</span>}
                </td>
                <td>{u.name ?? <span className="muted">—</span>}</td>
                <td>
                  <span className={`badge ${u.role}`}>{u.role}</span>
                </td>
                <td>
                  <span className={`badge ${u.status}`}>{u.status}</span>
                </td>
                <td>
                  <div className="chips">
                    {methods.password && <span className="badge">password</span>}
                    {methods.google && <span className="badge google">Google</span>}
                    {!methods.password && !methods.google && <span className="muted">—</span>}
                  </div>
                  <div className="muted sub">{signedInLabel(u, now)}</div>
                </td>
                <td>
                  <span className={`badge ${pw.tone === 'warn' || pw.tone === 'bad' ? pw.tone : ''}`}>{pw.label}</span>
                  {lock && <div className="err sub">{lock}</div>}
                </td>
                <td title={fmt(u.last_seen_at)}>{relativeTime(u.last_seen_at, now)}</td>
                <td>
                  <UserFeaturesDropdown user={u} features={features.data} reload={features.reload} />
                </td>
                <td className="row-actions" title={hint ?? undefined}>
                  <button onClick={() => open({ kind: 'edit', user: u })}>Edit</button>
                  <button disabled={locked || busy.has(u.id)} onClick={() => void flip(u, { status: u.status === 'active' ? 'disabled' : 'active' })}>
                    {u.status === 'active' ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => open({ kind: 'reset', user: u })}>Reset password</button>
                  <button className="danger" disabled={locked} onClick={() => open({ kind: 'delete', user: u })}>
                    Delete
                  </button>
                  {hint && <div className="muted sub">{hint}</div>}
                </td>
              </tr>
            );
          })}
          {users.data && rows.length === 0 && (
            <tr>
              <td colSpan={9} className="muted">
                {users.data.length === 0 ? 'No users.' : 'No user matches the filter.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      {dialog?.kind === 'create' && (
        <CreateDialog
          onClose={() => setDialog(null)}
          onDone={(result) => {
            setDialog({ kind: 'secret', result, reason: 'created' });
            void users.reload();
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditDialog
          user={dialog.user}
          locked={selfLimits(dialog.user, meEmail).hint}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void users.reload();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete user"
          body={`Delete ${dialog.user.email}? This cannot be undone. Users with data cannot be deleted: disable them instead.`}
          confirm="Delete"
          danger
          run={() => deleteUser(dialog.user.id)}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void users.reload();
          }}
        />
      )}
      {dialog?.kind === 'reset' && (
        <ConfirmDialog
          title="Reset password"
          body={`Give ${dialog.user.email} a new temporary password? Their current password stops working and their password sessions end.`}
          confirm="Reset password"
          run={async () => {
            const result = await resetUserPassword(dialog.user.id);
            setDialog({ kind: 'secret', result, reason: 'reset' });
            void users.reload();
          }}
          onClose={() => setDialog(null)}
          onDone={() => undefined}
        />
      )}
      {dialog?.kind === 'secret' && <SecretDialog result={dialog.result} reason={dialog.reason} onClose={() => setDialog(null)} />}
    </>
  );
}

/** A modal <dialog>. Escape always calls onClose; a backdrop click does only with `backdropClose` (not for forms or the temp password, so nothing is lost by a stray click). */
function Modal({ title, onClose, backdropClose, children }: { title: string; onClose: () => void; backdropClose?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose} onClick={(e) => backdropClose && e.target === e.currentTarget && onClose()}>
      <h3>{title}</h3>
      {children}
    </dialog>
  );
}

function useSubmit(run: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onDone();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: (r: AdminUserWithTempPassword) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const { busy, error, submit } = useSubmit(
    async () => onDone(await createUser({ email: email.trim(), name: name.trim() || undefined, role })),
    () => undefined,
  );
  return (
    <Modal title="Create user" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="cu-email">E-mail</label>
          <input id="cu-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cu-name">Name (optional)</label>
          <input id="cu-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cu-role">Role</label>
          <select id="cu-role" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'user')}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        {error && <div className="err">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !email.trim()}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditDialog({ user, locked, onClose, onDone }: { user: AdminUser; locked: string | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(user.name ?? '');
  const [role, setRole] = useState(user.role);
  const [status, setStatus] = useState(user.status);
  const { busy, error, submit } = useSubmit(() => {
    const patch: Parameters<typeof updateUser>[0] = { id: user.id };
    const trimmed = name.trim();
    if (trimmed !== (user.name ?? '')) patch.name = trimmed || null;
    if (role !== user.role) patch.role = role;
    if (status !== user.status) patch.status = status;
    return updateUser(patch);
  }, onDone);
  return (
    <Modal title={`Edit ${user.email}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="eu-name">Name</label>
          <input id="eu-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="eu-role">Role</label>
          <select id="eu-role" value={role} disabled={!!locked} onChange={(e) => setRole(e.target.value as 'admin' | 'user')}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="eu-status">Status</label>
          <select id="eu-status" value={status} disabled={!!locked} onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}>
            <option value="active">active</option>
            <option value="disabled">disabled</option>
          </select>
        </div>
        {locked && <div className="muted sub">Role and status are locked. {locked}</div>}
        {error && <div className="err">{error}</div>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog(props: {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  run: () => Promise<unknown>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, error, submit } = useSubmit(props.run, props.onDone);
  return (
    <Modal title={props.title} onClose={props.onClose} backdropClose>
      <p>{props.body}</p>
      {error && <div className="err">{error}</div>}
      <div className="dialog-actions">
        <button onClick={props.onClose}>Cancel</button>
        <button className={props.danger ? 'danger' : 'primary'} disabled={busy} onClick={() => void submit()}>
          {props.confirm}
        </button>
      </div>
    </Modal>
  );
}

/** The temp password lives only in this component's props/state; closing the dialog drops it. */
function SecretDialog({ result, reason, onClose }: { result: AdminUserWithTempPassword; reason: 'created' | 'reset'; onClose: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.temp_password);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <Modal title={reason === 'created' ? 'User created' : 'Password reset'} onClose={onClose}>
      <p>
        Temporary password for <strong>{result.user.email}</strong>. It is shown only now: you cannot see it again.
      </p>
      <div className="secret">
        <code data-testid="temp-password">{result.temp_password}</code>
        <button onClick={() => void copy()}>{copied === 'yes' ? 'Copied' : 'Copy'}</button>
      </div>
      {copied === 'failed' && <div className="err sub">Copy failed: select the password and copy it by hand.</div>}
      <p className="muted">
        Give it to the person yourself. It expires in 7 days, and they must choose a new password at first sign-in.
      </p>
      <div className="dialog-actions">
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
