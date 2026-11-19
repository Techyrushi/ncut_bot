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
      <form className="panel account-security-form" onSubmit={submit}>
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
        {error && <div className="alert error" role="alert">{error}</div>}
        {success && <div className="alert" role="status">{success}</div>}
        <button className="primary-button" disabled={busy}>
          {busy ? 'Saving…' : 'Save account changes'}
        </button>
      </form>
    </div>
  );
}
