'use client';

import type { DemoAccount } from '@app/shared';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type SubmitEvent } from 'react';

interface Props {
  demo: { accounts: DemoAccount[]; password: string } | null;
}

const ROLE_LABEL: Record<DemoAccount['role'], string> = {
  owner: 'owner',
  agent: 'agent',
  'platform-admin': 'platform admin',
};

function messageFor(status: number): string {
  if (status === 401) return 'Email or password is wrong. Check both and try again.';
  if (status === 429) return 'Too many attempts from this device. Wait a minute, then try again.';
  return 'Sign-in failed on the server. Try again in a moment.';
}

export function SignInForm({ demo }: Props) {
  const router = useRouter();
  const errorId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, rememberMe: true }),
      });
      if (response.ok) {
        router.replace('/');
        router.refresh();
        return;
      }
      setError(messageFor(response.status));
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  function fillAccount(account: DemoAccount) {
    if (!demo) return;
    setEmail(account.email);
    setPassword(demo.password);
    setError(null);
    passwordRef.current?.focus();
  }

  return (
    <>
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => void onSubmit(event)}
        aria-describedby={error ? errorId : undefined}
      >
        <div>
          <label htmlFor="email" className="block text-label font-semibold">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            className="field mt-1"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-label font-semibold">
            Password
          </label>
          <input
            id="password"
            ref={passwordRef}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="field mt-1"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>

        {error && (
          <p id={errorId} role="alert" className="border-l-4 border-stamp pl-3 text-stamp">
            {error}
          </p>
        )}

        <button type="submit" className="button button-person" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {demo && (
        <section aria-labelledby="demo-heading" className="mt-12 border-t border-rule pt-6">
          <h2 id="demo-heading" className="text-label font-semibold">
            Demo accounts
          </h2>
          <p className="mt-1 text-list text-graphite">
            Every demo account uses the password{' '}
            <span className="mono whitespace-nowrap text-ink">{demo.password}</span>. The businesses
            and people are fictional.
          </p>
          <ul className="mt-3 divide-y divide-rule border-y border-rule">
            {demo.accounts.map((account) => (
              <li key={account.email} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-list">
                    <span className="font-semibold">{account.name}</span>{' '}
                    <span className="text-graphite">
                      · {ROLE_LABEL[account.role]}
                      {account.business ? `, ${account.business}` : ''}
                    </span>
                  </p>
                  <p className="mono truncate text-meta text-graphite">{account.email}</p>
                </div>
                <button
                  type="button"
                  className="button button-quiet px-2 py-1 text-label"
                  onClick={() => {
                    fillAccount(account);
                  }}
                  aria-label={`Fill in ${account.name}'s email and password`}
                >
                  Use
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
