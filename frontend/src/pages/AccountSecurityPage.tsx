import { useState, type FormEvent } from 'react';
import { PasswordField } from '../components/PasswordField';
import { useAuth } from '../contexts/AuthContext';

export function AccountSecurityPage() {
  const { user, updateAccount } = useAuth();
  const [email, setEmail] = useState(user?.email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSuccess('');

    if (newPassword && newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    if (!newPassword && confirmPassword) {
      setError('Enter a new password before confirming it.');
      return;
    }

    const update: { currentPassword: string; email?: string; newPassword?: string } = { currentPassword };
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail && normalizedEmail !== user?.email.toLowerCase()) update.email = normalizedEmail;
    if (newPassword) update.newPassword = newPassword;
    if (update.email === undefined && update.newPassword === undefined) {
      setError('Enter a new email address or password to save a change.');
      return;
    }

    setBusy(true);
    try {
      await updateAccount(update);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess('Account updated. Other active sessions have been signed out.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACCOUNT / SECURITY</div>
          <h1>Account security</h1>
          <p>Update your login email or password. Your current password is required to confirm changes.</p>
        </div>
      </div>
      <div className="account-security-layout">
        <form className="panel account-security-form" onSubmit={submit}>
          <div className="account-security-form-heading">
            <div className="eyebrow">LOGIN CREDENTIALS</div>
            <h2>Update your account</h2>
            <p>Enter your current password to confirm any email or password change.</p>
          </div>
          <div className="form-grid">
            <label className="wide" htmlFor="account-email">
              Login email
              <input
                id="account-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <PasswordField
              id="current-password"
              label="Current password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={setCurrentPassword}
              required
            />
            <PasswordField
              id="new-password"
              label="New password"
              autoComplete="new-password"
              value={newPassword}
              onChange={setNewPassword}
              placeholder="At least 12 characters"
              minLength={12}
            />
            <PasswordField
              id="confirm-password"
              label="Confirm new password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              minLength={12}
            />
          </div>
          <p className="small muted">
            Changing your email or password revokes previous sessions. Store your new password securely; it cannot be
            recovered from the application.
          </p>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {success && (
            <div className="alert" role="status">
              {success}
            </div>
          )}
          <button className="primary-button account-security-submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save account changes'}
          </button>
        </form>
        <aside className="account-security-aside">
          <section className="panel account-profile-card">
            <div className="eyebrow">SIGNED-IN ACCOUNT</div>
            <div className="account-profile">
              <span className="account-profile-avatar">{(user?.name ?? 'U').slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{user?.name ?? 'Admin user'}</strong>
                <span>{user?.role === 'ADMIN' ? 'Administrator' : 'Sales representative'}</span>
              </div>
            </div>
            <div className="account-profile-email">{user?.email}</div>
          </section>
          <section className="panel account-security-tips">
            <div className="eyebrow">SECURITY CHECKLIST</div>
            <h2>Keep your account protected</h2>
            <ul>
              <li>
                <span aria-hidden="true">✓</span>
                Current password confirms every change
              </li>
              <li>
                <span aria-hidden="true">✓</span>
                New passwords must be at least 12 characters
              </li>
              <li>
                <span aria-hidden="true">✓</span>
                Other sessions are signed out after an update
              </li>
            </ul>
            <p>Use a unique password and never share it with another team member.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
