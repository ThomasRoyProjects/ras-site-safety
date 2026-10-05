import React from 'react';
import { api } from '../api.js';
import { isAbortError } from '../isAbortError.js';
import { validatePassword } from '../passwordPolicy.js';
import PasswordField from './PasswordField.jsx';
import Pagination from './Pagination.jsx';
import './StaffView.css';

const PAGE_SIZE = 10;
const emptyForm = { name: '', email: '', role: 'framer', password: '' };

function explain(error, fallback) {
  if (error?.status === 403) return 'You are not allowed to manage staff accounts.';
  if (error?.status === 409) return 'An account already uses that email address.';
  if (error?.status === 429) return 'Password capacity is temporarily unavailable. Try again shortly.';
  return error?.message || fallback;
}

function temporaryPasswordError(password, confirmation) {
  const error = validatePassword({
    newPassword: password,
    confirmPassword: confirmation
  });

  return error
    .replace('New passwords', 'Temporary passwords')
    .replace('New password', 'Temporary password');
}

function StaffCreateForm({
  disabled,
  onCreated,
  onMessage,
  onSessionExpired,
  onBusyChange
}) {
  const [form, setForm] = React.useState(emptyForm);
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const requestRef = React.useRef(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setError('');
    onMessage('');
  };

  const updateConfirmation = (event) => {
    setConfirmPassword(event.target.value);
    setError('');
    onMessage('');
  };

  async function create(event) {
    event.preventDefault();
    setError('');
    onMessage('');

    const nameLength = Array.from(form.name.trim()).length;
    if (nameLength < 1 || nameLength > 100) {
      setError('Name must be 1–100 characters.');
      return;
    }

    const passwordError = temporaryPasswordError(form.password, confirmPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setBusy(true);
    onBusyChange(true);
    const controller = new AbortController();
    requestRef.current = controller;

    try {
      const data = await api('/admin/users', {
        method: 'POST',
        body: form,
        signal: controller.signal
      });
      if (controller.signal.aborted || !mountedRef.current) return;

      onCreated(data.user);
      setForm(emptyForm);
      setConfirmPassword('');
      onMessage(`Account created for ${data.user.name}. Share the temporary password securely; it must be changed at first sign-in.`);
    } catch (requestError) {
      if (controller.signal.aborted || isAbortError(requestError) || !mountedRef.current) return;
      if (requestError?.status === 401) onSessionExpired?.();
      else setError(explain(requestError, 'Account could not be created.'));
    } finally {
      if (mountedRef.current && requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  const formDisabled = disabled || busy;

  return (
    <section className="panel staff-create-panel" aria-labelledby="staff-create-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Staff accounts</p>
          <h2 id="staff-create-heading">Create an account</h2>
        </div>
      </div>
      <p className="muted">New accounts receive a temporary password and must change it before accessing the workspace.</p>
      {error && <p className="alert staff-form-alert" role="alert">{error}</p>}
      <details className="staff-create-details">
        <summary>Open account creation form</summary>
        <form className="field-grid staff-form" onSubmit={create} autoComplete="off">
          <input
            className="visually-hidden"
            type="text"
            name="username"
            autoComplete="section-new-staff username"
            tabIndex="-1"
            aria-hidden="true"
            readOnly
            value={form.email}
          />
          <label className="field" htmlFor="staff-name">
            Name
            <input
              id="staff-name"
              name="name"
              autoComplete="section-new-staff name"
              value={form.name}
              onChange={update}
              disabled={formDisabled}
              required
            />
          </label>
          <label className="field" htmlFor="staff-email">
            Email
            <input
              id="staff-email"
              name="email"
              type="email"
              autoComplete="section-new-staff email"
              maxLength={254}
              value={form.email}
              onChange={update}
              disabled={formDisabled}
              required
            />
          </label>
          <label className="field" htmlFor="staff-role">
            Role
            <select id="staff-role" name="role" value={form.role} onChange={update} disabled={formDisabled}>
              <option value="framer">Framer</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <PasswordField
            id="staff-password"
            name="password"
            label="Temporary password"
            value={form.password}
            onChange={update}
            autoComplete="section-new-staff new-password"
            disabled={formDisabled}
            describedBy="staff-password-guidance"
          />
          <PasswordField
            id="staff-confirm-password"
            label="Confirm temporary password"
            value={confirmPassword}
            onChange={updateConfirmation}
            autoComplete="section-new-staff new-password"
            disabled={formDisabled}
            describedBy="staff-password-guidance"
          />
          <p id="staff-password-guidance" className="muted staff-guidance">
            12–128 characters. Do not reuse a personal password.
          </p>
          <button className="button staff-submit" type="submit" disabled={formDisabled}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      </details>
    </section>
  );
}

function StaffDirectory({
  users,
  page,
  busy,
  currentUserId,
  onPageChange,
  onPageReset,
  onUsersLoaded,
  onLoadingChange,
  onSessionExpired,
  onBeginReset
}) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const requestRef = React.useRef({ id: 0, controller: null });
  const mountedRef = React.useRef(true);

  const load = React.useCallback(() => {
    const requestId = requestRef.current.id + 1;
    requestRef.current.id = requestId;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current.controller = controller;
    setLoading(true);
    onLoadingChange(true);
    setError('');

    api('/admin/users', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && mountedRef.current && requestId === requestRef.current.id) {
          onUsersLoaded(Array.isArray(data?.users) ? data.users : []);
          onPageReset();
        }
      })
      .catch((requestError) => {
        if (controller.signal.aborted || !mountedRef.current || requestId !== requestRef.current.id || isAbortError(requestError)) {
          return;
        }
        if (requestError?.status === 401) onSessionExpired?.();
        else setError(explain(requestError, 'Staff accounts could not be loaded.'));
      })
      .finally(() => {
        if (mountedRef.current && !controller.signal.aborted && requestId === requestRef.current.id) {
          setLoading(false);
          onLoadingChange(false);
        }
      });
  }, [onLoadingChange, onPageReset, onSessionExpired, onUsersLoaded]);

  React.useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
      requestRef.current.id += 1;
      requestRef.current.controller?.abort();
    };
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
  const visibleUsers = users.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  React.useEffect(() => {
    if (page > pageCount) onPageChange(pageCount);
  }, [onPageChange, page, pageCount]);

  return (
    <section className="panel staff-list-panel" aria-labelledby="staff-list-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Authorized users</p>
          <h2 id="staff-list-heading">Staff directory</h2>
        </div>
        <button className="button secondary" type="button" onClick={load} disabled={loading || busy}>
          Refresh
        </button>
      </div>
      {!loading && !error && (
        <p className="staff-result-count muted">
          {users.length} {users.length === 1 ? 'account' : 'accounts'}
        </p>
      )}
      {error && <p className="alert" role="alert">{error}</p>}
      {loading ? (
        <p role="status" className="muted">Loading staff accounts…</p>
      ) : !error && users.length === 0 ? (
        <p className="empty-state">No staff accounts found.</p>
      ) : !error ? (
        <>
          <ul className="staff-list">
            {visibleUsers.map((item) => (
              <li className="staff-card" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.email}</span>
                  <small>
                    {item.role === 'admin' ? 'Admin' : 'Framer'} · Added{' '}
                    {item.created_at ? new Date(item.created_at).toLocaleDateString() : '—'}
                  </small>
                </div>
                <div className="staff-card-actions">
                  <span className={`status-badge ${item.must_change_password ? 'status-temporary' : ''}`}>
                    {item.must_change_password ? 'Temporary password' : 'Active'}
                  </span>
                  {item.id === currentUserId ? (
                    <span className="muted">Use Account to change</span>
                  ) : (
                    <button
                      className="button secondary"
                      type="button"
                      disabled={busy}
                      aria-label={`Reset password for ${item.name}`}
                      onClick={(event) => onBeginReset(item, event.currentTarget)}
                    >
                      Reset password
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={page} pageCount={pageCount} onPageChange={onPageChange} label="Staff directory pages" />
        </>
      ) : null}
    </section>
  );
}

function ResetPasswordDialog({
  user,
  onUpdated,
  onClose,
  onMessage,
  onSessionExpired,
  onBusyChange
}) {
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const dialogRef = React.useRef(null);
  const requestRef = React.useRef(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);

  React.useEffect(() => {
    if (!user || !dialogRef.current) return undefined;
    setPassword('');
    setConfirmation('');
    setError('');
    const dialog = dialogRef.current;
    if (!dialog.open) dialog.showModal();
    const frame = requestAnimationFrame(() => dialog.querySelector('#reset-password')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [user]);

  const close = () => {
    if (!busy && dialogRef.current?.open) dialogRef.current.close();
  };

  async function reset(event) {
    event.preventDefault();
    setError('');
    onMessage('');
    const passwordError = temporaryPasswordError(password, confirmation);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    setBusy(true);
    onBusyChange(true);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const data = await api(`/admin/users/${encodeURIComponent(user.id)}/password`, {
        method: 'POST',
        body: { password },
        signal: controller.signal
      });
      if (controller.signal.aborted || !mountedRef.current) return;
      onUpdated(data.user);
      onMessage(`Temporary password reset for ${data.user.name}. They must change it at first sign-in.`);
      dialogRef.current?.close();
    } catch (requestError) {
      if (controller.signal.aborted || isAbortError(requestError) || !mountedRef.current) return;
      if (requestError?.status === 401) onSessionExpired?.();
      else if (requestError?.status === 409) setError(requestError.message || 'Password was changed by another request. Try again.');
      else setError(explain(requestError, 'Password could not be reset.'));
    } finally {
      if (mountedRef.current && requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="staff-reset-dialog"
      aria-labelledby="reset-heading"
      aria-describedby="reset-description"
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      {user && (
        <section className="panel staff-reset-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Account security</p>
              <h2 id="reset-heading">Reset temporary password</h2>
            </div>
            <button type="button" className="button secondary" onClick={close} disabled={busy}>Cancel</button>
          </div>
          <p id="reset-description" className="muted">
            {user.name || 'This account'} will be signed out everywhere and must change this password at next sign-in.
          </p>
          {error && <p className="alert staff-reset-error" role="alert">{error}</p>}
          <form className="stack staff-reset-form" onSubmit={reset} autoComplete="off">
            <input
              className="visually-hidden"
              type="text"
              name="username"
              autoComplete="section-staff-reset username"
              tabIndex="-1"
              aria-hidden="true"
              readOnly
              value={user.email || ''}
            />
            <PasswordField
              id="reset-password"
              label="New temporary password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError('');
              }}
              autoComplete="section-staff-reset new-password"
              disabled={busy}
              describedBy="reset-password-guidance"
            />
            <PasswordField
              id="reset-confirm-password"
              label="Confirm temporary password"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
                setError('');
              }}
              autoComplete="section-staff-reset new-password"
              disabled={busy}
              describedBy="reset-password-guidance"
            />
            <p id="reset-password-guidance" className="muted">Use 12–128 characters.</p>
            <button className="button" type="submit" disabled={busy}>{busy ? 'Resetting…' : 'Reset password'}</button>
          </form>
        </section>
      )}
    </dialog>
  );
}

export default function StaffView({ user, onSessionExpired }) {
  const [users, setUsers] = React.useState([]);
  const [directoryLoading, setDirectoryLoading] = React.useState(true);
  const [createBusy, setCreateBusy] = React.useState(false);
  const [resetBusy, setResetBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [resetTarget, setResetTarget] = React.useState(null);
  const resetReturnFocusRef = React.useRef(null);

  const handleUsersLoaded = React.useCallback((nextUsers) => {
    setUsers(nextUsers);
  }, []);

  const handleCreated = React.useCallback((newUser) => {
    setUsers((current) => [newUser, ...current.filter((item) => item.id !== newUser.id)]);
    setPage(1);
  }, []);

  const handleUpdated = React.useCallback((updatedUser) => {
    setUsers((current) => current.map((item) => (
      item.id === updatedUser.id ? updatedUser : item
    )));
  }, []);

  const beginReset = React.useCallback((item, button) => {
    resetReturnFocusRef.current = button;
    setResetTarget(item);
    setMessage('');
  }, []);

  const finishReset = React.useCallback(() => {
    setResetTarget(null);
    const returnFocus = resetReturnFocusRef.current;
    resetReturnFocusRef.current = null;
    requestAnimationFrame(() => returnFocus?.focus?.());
  }, []);
  const resetPage = React.useCallback(() => setPage(1), []);

  return (
    <div className="staff-view" data-workspace-view="staff">
      <h1 className="visually-hidden" tabIndex={-1}>Staff management</h1>
      {message && <p className="alert success" role="status">{message}</p>}
      <StaffCreateForm
        disabled={directoryLoading || resetBusy}
        onCreated={handleCreated}
        onMessage={setMessage}
        onSessionExpired={onSessionExpired}
        onBusyChange={setCreateBusy}
      />
      <StaffDirectory
        users={users}
        page={page}
        busy={createBusy || resetBusy}
        currentUserId={user?.id}
        onPageChange={setPage}
        onPageReset={resetPage}
        onUsersLoaded={handleUsersLoaded}
        onLoadingChange={setDirectoryLoading}
        onSessionExpired={onSessionExpired}
        onBeginReset={beginReset}
      />
      <ResetPasswordDialog
        user={resetTarget}
        onUpdated={handleUpdated}
        onClose={finishReset}
        onMessage={setMessage}
        onSessionExpired={onSessionExpired}
        onBusyChange={setResetBusy}
      />
    </div>
  );
}
