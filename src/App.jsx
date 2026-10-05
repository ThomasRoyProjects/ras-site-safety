import React from 'react';
import { api } from './api.js';
import FramerView from './components/FramerView.jsx';
import AdminView from './components/AdminView.jsx';
import AccountView from './components/AccountView.jsx';
import PasswordField from './components/PasswordField.jsx';
import './components/AccountView.css';

const ADMIN_NAV = [
  ['overview', 'Overview'], ['submissions', 'Submissions'], ['staff', 'Staff'], ['account', 'Account']
];
const FRAMER_NAV = [
  ['overview', 'Overview'], ['new', 'New submission'], ['history', 'History'], ['account', 'Account']
];



export default function App() {
  const [user, setUser] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [accountBusy, setAccountBusy] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [noticeSuccess, setNoticeSuccess] = React.useState(false);
  const [activeView, setActiveView] = React.useState('overview');
  const loginEmailRef = React.useRef(null);
  const previousViewRef = React.useRef(null);

  React.useEffect(() => {
    const controller = new AbortController();
    api('/session', { signal: controller.signal })
      .then((data) => {
        setUser(data.user);
        setEmail(data.user?.email || '');
        if (data.user?.must_change_password) setActiveView('account');
      })
      .catch((error) => {
        if (!controller.signal.aborted && error.status !== 401) {
          setNoticeSuccess(false);
          setNotice(`Cannot reach your session. ${error.message}`);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const sessionExpired = React.useCallback(() => {
    setUser(null);
    setPassword('');
    setActiveView('overview');
    setAccountBusy(false);
    setNoticeSuccess(false);
    setNotice('Your session has expired. Log in to continue.');
  }, []);

  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    setNoticeSuccess(false);
    try {
      const data = await api('/login', {
        method: 'POST',
        body: { email, password }
      });
      setUser(data.user);
      setEmail(data.user?.email || email);
      setPassword('');
      setActiveView(data.user?.must_change_password ? 'account' : 'overview');
      setAccountBusy(false);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setNotice('');
    setNoticeSuccess(false);
    try {
      await api('/logout', { method: 'POST' });
      setUser(null);
      setPassword('');
      setActiveView('overview');
      setAccountBusy(false);
    } catch (error) {
      setNotice(`Logout failed. ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  const passwordChanged = React.useCallback(() => {
    setUser(null);
    setPassword('');
    setNoticeSuccess(true);
    setNotice('Password changed. Log in with your new password.');
    setActiveView('overview');
    setAccountBusy(false);
    requestAnimationFrame(() => loginEmailRef.current?.focus());
  }, []);

  const forcedPassword = Boolean(user?.must_change_password);
  React.useEffect(() => {
    if (user && !forcedPassword && previousViewRef.current !== null && previousViewRef.current !== activeView) {
      requestAnimationFrame(() => {
        document.querySelector(`[data-workspace-view="${activeView}"] h1`)?.focus();
      });
    }
    previousViewRef.current = activeView;
  }, [activeView, forcedPassword, user]);
  const nav = user?.role === 'admin' ? ADMIN_NAV : FRAMER_NAV;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="app-header">
        <div className="header-inner">
          <a
            className="brand"
            href="#main-content"
            aria-label="Site Safety — Ron Anderson & Sons"
            aria-disabled={user && (busy || accountBusy) ? true : undefined}
            onClick={user ? (event) => {
              event.preventDefault();
              if (!busy && !accountBusy) setActiveView('overview');
            } : undefined}
          >
            <img src="/ras-logo.webp" alt="" width="91" height="60" />
            <span>
              <strong>SITE SAFETY</strong>
              <small>Ron Anderson &amp; Sons</small>
            </span>
          </a>
          {user ? (
            <div className="user-menu">
              <div>
                <strong>{user.name}</strong>
                <span>{user.role === 'admin' ? 'Admin' : 'Framer'}</span>
              </div>
              <button className="button header-logout" type="button" onClick={logout} disabled={busy || accountBusy}>
                {busy ? 'Logging out…' : 'Log out'}
              </button>
            </div>
          ) : (
            <span className="header-caption">WOOD FRAME CONSTRUCTION · VANCOUVER ISLAND</span>
          )}
        </div>
      </header>

      <div className={`workspace-frame ${user && !forcedPassword ? 'with-navigation' : ''}`}>
      {user && !forcedPassword && (
        <nav className="workspace-nav" aria-label="Workspace navigation">
          <div className="workspace-nav-inner">
            {nav.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={activeView === id ? 'active' : ''}
                aria-current={activeView === id ? 'page' : undefined}
                onClick={() => setActiveView(id)}
                disabled={busy || accountBusy}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
      )}

      <main id="main-content" className={user ? 'workspace' : 'login-layout'} tabIndex="-1">
        {loading ? (
          <section className="panel session-loading" role="status">Checking your session…</section>
        ) : user ? (
          forcedPassword ? (
            <>
              {notice && <p className="alert" role="alert">{notice}</p>}
              <AccountView
                email={email}
                forced
                onPasswordChanged={passwordChanged}
                onSessionExpired={sessionExpired}
                onBusyChange={setAccountBusy}
              />
            </>
          ) : (
            <>
              {notice && (
                <p className={noticeSuccess ? 'alert success' : 'alert'} role={noticeSuccess ? 'status' : 'alert'}>
                  {notice}
                </p>
              )}
              <div hidden={activeView === 'account'} data-workspace-view={activeView}>
                {user.role === 'admin' ? (
                  <AdminView
                    key={user.id}
                    user={user}
                    view={activeView}
                    onSessionExpired={sessionExpired}
                  />
                ) : (
                  <FramerView
                    key={user.id}
                    user={user}
                    view={activeView}
                    onSessionExpired={sessionExpired}
                  />
                )}
              </div>
              {activeView === 'account' && (
                <div data-workspace-view="account">
                  <AccountView
                    email={email}
                    onPasswordChanged={passwordChanged}
                    onSessionExpired={sessionExpired}
                    onBusyChange={setAccountBusy}
                  />
                </div>
              )}
            </>
          )
        ) : (
          <>
            <section className="login-intro">
              <p className="eyebrow">BUILT FOR THE CREW</p>
              <h1>A safer start.<br />Every site.<br />Every day.</h1>
              <p>One place for daily safety checks, site photos, and crew records.</p>
              <div className="intro-rule" />
              <p className="intro-caption">FRAMERS FIRST. SAFETY ALWAYS.</p>
            </section>
            <section className="panel login-panel" aria-labelledby="login-title">
              <p className="eyebrow">YOUR WORKSPACE</p>
              <h2 id="login-title">Log in to site safety</h2>
              <p className="muted">Use your account to open your crew workspace.</p>
              {notice && (
                <p className={noticeSuccess ? 'alert success' : 'alert'} role={noticeSuccess ? 'status' : 'alert'}>
                  {notice}
                </p>
              )}
              <form onSubmit={login} className="stack">
                <label className="field" htmlFor="login-email">
                  Email address
                  <input
                    ref={loginEmailRef}
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <PasswordField
                  id="login-password"
                  label="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  disabled={busy}
                />
                <button className="button login-submit" type="submit" disabled={busy}>
                  {busy ? 'Logging in…' : 'Log in'}
                </button>
              </form>
              <p className="login-help">Need an account or password reset? Contact your administrator.</p>
            </section>
          </>
        )}
      </main>
      </div>
      <footer className="app-footer">
        <span>Ron Anderson &amp; Sons · Site Safety</span>
        <span>Assessment demo · Fictional data only</span>
      </footer>
    </div>
  );
}

