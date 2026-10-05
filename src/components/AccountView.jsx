import React from 'react';
import { api } from '../api.js';
import { isAbortError } from '../isAbortError.js';
import { validatePassword } from '../passwordPolicy.js';
import PasswordField from './PasswordField.jsx';
export default function AccountView({ email = '', forced = false, onPasswordChanged, onSessionExpired, onBusyChange }) {
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const requestRef = React.useRef(null);

  React.useEffect(() => {
    return () => requestRef.current?.abort();
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError('');

    const validationError = validatePassword({
      currentPassword,
      newPassword,
      confirmPassword
    });

    if (validationError) {
      setError(validationError);
      return;
    }

    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    onBusyChange?.(true);

    try {
      await api('/account/password', {
        method: 'POST',
        body: {
          current_password: currentPassword,
          new_password: newPassword
        },
        signal: controller.signal
      });

      if (controller.signal.aborted) {
        return;
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onPasswordChanged?.();
    } catch (errorResponse) {
      if (controller.signal.aborted || isAbortError(errorResponse)) {
        return;
      }

      if (errorResponse.status === 401) {
        onSessionExpired?.();
      } else {
        setError(errorResponse.message || 'Password could not be changed.');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;

        if (!controller.signal.aborted) {
          setBusy(false);
          onBusyChange?.(false);
        }
      }
    }
  }

  return (
    <section className="panel account-panel" aria-labelledby="account-heading">
      <p className="eyebrow">{forced ? 'First sign-in' : 'Account security'}</p>
      <h1 id="account-heading" tabIndex={-1}>
        {forced ? 'Set your new password' : 'Change your password'}
      </h1>
      <p className="muted">
        {forced
          ? 'Your administrator issued a temporary password. Change it before opening your workspace.'
          : 'Use a new password to keep your account secure.'}
      </p>
      {error && <p className="alert" role="alert">{error}</p>}
      <form className="account-form" onSubmit={submit}>
        <input className="visually-hidden" type="text" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" />
        <PasswordField
          id="account-current-password"
          label="Current password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          autoComplete="current-password"
          disabled={busy}
        />
        <PasswordField
          id="account-new-password"
          label="New password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
          disabled={busy}
          describedBy="password-guidance"
        />
        <PasswordField
          id="account-confirm-password"
          label="Confirm new password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          disabled={busy}
          describedBy="password-guidance"
        />
        <p id="password-guidance" className="muted">
          Use 12–128 characters. Avoid reusing your current password.
        </p>
        <button className="button" type="submit" disabled={busy}>
          {busy ? 'Saving password…' : 'Save new password'}
        </button>
      </form>
    </section>
  );
}
