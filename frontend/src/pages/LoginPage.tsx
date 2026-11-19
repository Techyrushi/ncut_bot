import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PasswordField } from '../components/PasswordField';

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
          <img className="brand-logo" src="/ncut_logo.jpeg" alt="N-CUT Abrasives" />
          <div>
            <strong>N-CUT</strong>
            <span>ABRASIVES SALES</span>
          </div>
        </div>
        <div className="art-copy">
          <div className="eyebrow">N-CUT ABRASIVES · SALES DESK</div>
          <h1>
            Quality abrasives,
            <br />
            helpful service,
            <br />
            <em>one conversation.</em>
          </h1>
          <p>Manage your abrasive catalogue, customer enquiries, and sales follow-ups in one place.</p>
        </div>
        <div className="art-stamp">
          N-CUT
          <br />
          ABRASIVES
        </div>
      </div>
      <form className="login-card" onSubmit={submit}>
        <div className="eyebrow">WELCOME BACK</div>
        <h2>Sign in to N-CUT Abrasives</h2>
        <p className="muted">Use your N-CUT sales workspace credentials to continue.</p>
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
        <PasswordField
          id="login-password"
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          placeholder="Enter your password"
          required
        />
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
