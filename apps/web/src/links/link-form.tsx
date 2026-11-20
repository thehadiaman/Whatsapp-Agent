'use client';

import {
  acceptInviteBodySchema,
  linkInfoSchema,
  resetPasswordBodySchema,
  type LinkInfo,
} from '@app/shared';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ApiRequestError, messageOf, request } from '../lib/client-api';

/**
 * Opening an invite or a password reset link, signed out. The link works
 * once; afterwards the person signs in as usual.
 */
export function LinkForm({ kind, token }: { kind: 'invite' | 'reset'; token: string }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    request(`/links/${kind}/${token}`, {}, linkInfoSchema).then(
      (found) => {
        setInfo(found);
        setName(found.name);
      },
      (e: unknown) => {
        setGone(messageOf(e));
      },
    );
  }, [kind, token]);

  if (gone) {
    return (
      <p role="alert" className="mt-6 border-l-4 border-stamp pl-3 text-stamp">
        {gone}
      </p>
    );
  }
  if (!info) return <p className="mono mt-6 text-meta text-graphite">Checking the link…</p>;
  if (done) {
    return (
      <div className="mt-6 space-y-3">
        <p role="status">
          {kind === 'invite' ? 'Your account is ready.' : 'Your password is changed.'} Sign in as{' '}
          <span className="mono">{done}</span>.
        </p>
        <a href="/sign-in" className="button button-person">
          Go to sign in
        </a>
      </div>
    );
  }

  const schema = kind === 'invite' ? acceptInviteBodySchema : resetPasswordBodySchema;
  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const body = kind === 'invite' ? { name, password } : { password };
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'Check the fields and try again.');
          return;
        }
        setBusy(true);
        setError(null);
        request(
          `/links/${kind}/${token}`,
          { method: 'POST', body: JSON.stringify(parsed.data) },
          z.object({ email: z.string() }),
        ).then(
          (result) => {
            setDone(result.email);
          },
          (e: unknown) => {
            setBusy(false);
            if (e instanceof ApiRequestError && e.status === 410) setGone(e.message);
            else setError(messageOf(e));
          },
        );
      }}
    >
      <p>
        {kind === 'invite'
          ? `${info.business} invited you to its support desk.`
          : `Choose a new password for your ${info.business} account.`}{' '}
        You will sign in as <span className="mono">{info.email}</span>.
      </p>
      {kind === 'invite' ? (
        <label className="block">
          <span className="text-label font-semibold">Your name</span>
          <input
            className="field mt-1"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            autoComplete="name"
          />
        </label>
      ) : null}
      <label className="block">
        <span className="text-label font-semibold">New password</span>
        <span className="block text-label text-graphite">At least 12 characters.</span>
        <input
          type="password"
          className="field mt-1"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          autoComplete="new-password"
        />
      </label>
      {error ? (
        <p role="alert" className="border-l-4 border-stamp pl-3 text-stamp">
          {error}
        </p>
      ) : null}
      <button type="submit" className="button button-person" disabled={busy}>
        {kind === 'invite' ? 'Create my account' : 'Set new password'}
      </button>
    </form>
  );
}
