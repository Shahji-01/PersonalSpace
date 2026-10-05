'use client';

import { useState, type FormEvent } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const field: React.CSSProperties = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  marginTop: '0.35rem',
  border: '1px solid rgba(0,0,0,0.25)',
  borderRadius: '8px',
  font: 'inherit',
  boxSizing: 'border-box',
};

export default function DeleteAccount() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const ready = Boolean(email.trim()) && Boolean(password) && confirm === 'DELETE';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || state === 'working') return;
    setState('working');
    setMessage('');
    try {
      const signIn = await fetch(`${API}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!signIn.ok) throw new Error('We could not verify your email and password.');
      const session: unknown = await signIn.json();
      const token =
        session && typeof session === 'object' && 'token' in session
          ? (session as { token?: string }).token
          : undefined;
      if (!token) throw new Error('We could not verify your identity. Try again.');

      const res = await fetch(`${API}/api/v1/account/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          confirmText: 'DELETE',
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      if (!res.ok)
        throw new Error('We could not start the deletion. You may already have a request pending.');
      const body: unknown = await res.json();
      const graceEndsAt =
        body && typeof body === 'object' && 'data' in body
          ? (body as { data?: { graceEndsAt?: string } }).data?.graceEndsAt
          : undefined;
      setState('done');
      setMessage(
        graceEndsAt
          ? `Your account is scheduled for deletion on ${new Date(graceEndsAt).toLocaleDateString()}. Sign in within 14 days to cancel.`
          : 'Your deletion request has been received.',
      );
    } catch (error) {
      setState('error');
      setMessage(
        error instanceof Error ? error.message : 'Something went wrong. Please try again.',
      );
    }
  }

  return (
    <main className="document">
      <p className="eyebrow">DEVELOPMENT DRAFT · NOT A LAUNCH NOTICE</p>
      <h1>Delete your account.</h1>
      <p>
        Deleting your account permanently removes your notes, tasks, reminders, learning library and
        money records. There is a 14-day grace period — sign in again during that time to cancel.
        Credentials and sessions are removed immediately and your profile is anonymized.
      </p>
      <p>
        Verify it is you by entering your email and password, then type <strong>DELETE</strong> to
        confirm.
      </p>

      {state === 'done' ? (
        <p role="status" style={{ color: '#1b7f4b', fontWeight: 600 }}>
          {message}
        </p>
      ) : (
        <form onSubmit={submit} style={{ maxWidth: 420, display: 'grid', gap: '0.9rem' }}>
          <label>
            Email
            <input
              style={field}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              style={field}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            Reason (optional)
            <input
              style={field}
              type="text"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label>
            Type DELETE to confirm
            <input
              style={field}
              type="text"
              autoCapitalize="characters"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          {state === 'error' && (
            <p role="alert" style={{ color: '#b3261e' }}>
              {message}
            </p>
          )}
          <button
            type="submit"
            disabled={!ready || state === 'working'}
            style={{
              padding: '0.7rem 1rem',
              borderRadius: '8px',
              border: 'none',
              background: !ready || state === 'working' ? 'rgba(0,0,0,0.3)' : '#b3261e',
              color: 'white',
              font: 'inherit',
              fontWeight: 600,
              cursor: !ready || state === 'working' ? 'not-allowed' : 'pointer',
            }}
          >
            {state === 'working' ? 'Working…' : 'Permanently delete my account'}
          </button>
        </form>
      )}
    </main>
  );
}
