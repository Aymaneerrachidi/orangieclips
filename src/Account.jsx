import React, { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { api, roleLabels } from './lib';
import { Modal } from './components';
export default function Account({ user, close, saved }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e) { e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget)); if (values.password !== values.confirm) return setError('The new passwords do not match.'); setBusy(true); setError(''); try { await api('/account/password', { method: 'POST', body: JSON.stringify(values) }); saved('Password changed. Other sessions have been signed out.'); } catch(e) { setError(e.message); } finally { setBusy(false); } }
  return <Modal title="Your account" close={close}><div className="account-identity"><span className="avatar">{user.name[0]}</span><div><strong>{user.name}</strong><p>{user.email}</p></div><span className={`role-badge ${user.role}`}>{roleLabels[user.role]}</span></div><h3 className="form-section-title"><KeyRound size={16}/>Change password</h3><form className="account-form" onSubmit={submit}><label>Current password<input type="password" name="currentPassword" required maxLength={200} autoComplete="current-password"/></label><label>New password<input type="password" name="password" required minLength={12} maxLength={200} autoComplete="new-password"/></label><label>Confirm new password<input type="password" name="confirm" required minLength={12} maxLength={200} autoComplete="new-password"/></label>{error && <p className="error" role="alert">{error}</p>}<button className="button primary" disabled={busy}><ShieldCheck size={16}/>{busy ? 'Saving...' : 'Change password'}</button></form></Modal>;
}
