import React, { useState } from 'react';

interface Props {
  onLoggedIn: (token: string, name: string, email: string) => void;
}

export default function AuthLogin({ onLoggedIn }: Props) {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const baseUrl: string = await new Promise(resolve => {
        chrome.storage.local.get({ zilvoBaseUrl: 'https://app.zilvo.co' }, items =>
          resolve(items.zilvoBaseUrl as string)
        );
      });

      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json() as {
        token?: string;
        user?: { name?: string; email?: string };
        error?: string;
      };
      if (!res.ok || !data.token) {
        setError(data.error || 'Invalid credentials.');
        return;
      }

      const name = data.user?.name || email;
      chrome.storage.local.set({
        zilvoToken: data.token,
        zilvoName:  name,
        zilvoEmail: email,
      }, () => {
        onLoggedIn(data.token!, name, email);
      });
    } catch {
      setError('Network error. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="url-form" onSubmit={handleLogin}>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
        Log in to your Zilvo account to save analyses to your dashboard.
      </p>

      <label className="form-label">Email</label>
      <input
        type="email"
        className="url-input"
        placeholder="you@company.com"
        value={email}
        onChange={e => { setEmail(e.target.value); setError(''); }}
        disabled={loading}
        autoFocus
      />

      <label className="form-label">Password</label>
      <input
        type="password"
        className="url-input"
        placeholder="••••••••"
        value={password}
        onChange={e => { setPassword(e.target.value); setError(''); }}
        disabled={loading}
      />

      {error && <p className="input-error">{error}</p>}

      <button type="submit" className="btn btn--primary" disabled={loading || !email || !password}>
        {loading ? 'Logging in…' : 'Log In to Zilvo'}
      </button>

      <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
        Don&apos;t have an account?{' '}
        <a
          href="#"
          style={{ color: 'var(--primary)' }}
          onClick={e => {
            e.preventDefault();
            chrome.storage.local.get({ zilvoBaseUrl: 'https://app.zilvo.co' }, items => {
              chrome.tabs.create({ url: `${items.zilvoBaseUrl}/signup` });
            });
          }}
        >
          Sign up free
        </a>
      </p>
    </form>
  );
}
