import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export function LoginPage() {
  const { user, isLoading, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (isLoading) {
    return (
      <div className="session-loading" role="status">
        Restoring your secure session…
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-art">
        <div className="brand">
          <div className="brand-mark">O</div>
          <div>
            <strong>orbit</strong>
            <span>SALES CONSOLE</span>
          </div>
        </div>
        <div className="art-copy">
          <div className="eyebrow">CONVERSATIONS THAT CONVERT</div>
          <h1>
            Turn every
            <br />
            conversation into
            <br />
            <em>momentum.</em>
          </h1>
          <p>One place to manage your catalogue, customers, and sales pipeline.</p>
        </div>
        <div className="art-stamp">
          META
          <br />
          CLOUD API
        </div>
      </div>
      <form className="login-card" onSubmit={submit}>
        <div className="eyebrow">WELCOME BACK</div>
        <h2>Sign in to Orbit</h2>
        <p className="muted">Use your workspace credentials to continue.</p>
        <label>
          Email address
          <input
            autoComplete="username"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>
        <label>
          Password
          <input
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
          />
        </label>
        {error && <div className="alert error">{error}</div>}
        <button className="primary-button full-width" disabled={busy}>
          {busy ? 'Signing in…' : 'Continue'} <span>→</span>
        </button>
        <div className="login-foot">
          SECURE WORKSPACE ACCESS <span>JWT PROTECTED</span>
        </div>
      </form>
    </div>
  );
}
