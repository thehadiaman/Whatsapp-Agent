'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
    } finally {
      router.replace('/sign-in');
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      className="button button-quiet px-2 py-1 text-label"
      onClick={() => void signOut()}
      disabled={pending}
    >
      Sign out
    </button>
  );
}
