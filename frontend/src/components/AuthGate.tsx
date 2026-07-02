import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import apiClient, { type AuthSessionView } from '../api/apiClient.js';
import { Icon } from './Icon.js';
import { useErrorReporter } from './ErrorToast.js';
import './components.css';

interface AuthGateProps {
  children: (session: AuthSessionView, onLogout: () => void) => ReactNode;
}

export function AuthGate({ children }: AuthGateProps): JSX.Element {
  const { reportError } = useErrorReporter();
  const [session, setSession] = useState<AuthSessionView | null>(null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void apiClient.auth
      .session(controller.signal)
      .then(setSession)
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        reportError(error);
        setSession({ authRequired: true, configured: false, authenticated: false });
      });
    return () => controller.abort();
  }, [reportError]);

  const handleLogin = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      try {
        setSession(await apiClient.auth.login(username, password));
        setPassword('');
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(false);
      }
    },
    [busy, password, reportError, username],
  );

  const handleLogout = useCallback(() => {
    void apiClient.auth.logout().finally(() => {
      setSession((current) => ({
        authRequired: current?.authRequired ?? true,
        configured: current?.configured ?? true,
        authenticated: false,
      }));
    });
  }, []);

  if (session === null) {
    return (
      <main className="nwa-auth-screen" aria-label="登录状态检查">
        <div className="nwa-auth-card">
          <Icon name="refresh" />
          <p>正在检查登录状态…</p>
        </div>
      </main>
    );
  }

  if (!session.authRequired || session.authenticated) {
    return <>{children(session, handleLogout)}</>;
  }

  return (
    <main className="nwa-auth-screen" aria-label="登录">
      <form className="nwa-auth-card" onSubmit={(event) => void handleLogin(event)}>
        <div className="nwa-auth-card__brand">
          <Icon name="settings" />
          <div>
            <h1>小说 Agent</h1>
            <p>登录后使用站点 API 和模型配置。</p>
          </div>
        </div>
        {!session.configured ? (
          <p className="nwa-auth-card__warning">
            线上登录未配置：请在 Netlify 环境变量设置 APP_AUTH_PASSWORD 和 APP_SESSION_SECRET。
          </p>
        ) : null}
        <label className="nwa-field">
          <span>账号</span>
          <input
            className="nwa-input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            disabled={busy || !session.configured}
          />
        </label>
        <label className="nwa-field">
          <span>密码</span>
          <input
            className="nwa-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={busy || !session.configured}
          />
        </label>
        <button
          type="submit"
          className="nwa-button"
          disabled={busy || !session.configured || username.trim().length === 0 || password.length === 0}
        >
          登录
        </button>
      </form>
    </main>
  );
}

export default AuthGate;
