import { DEMO_ACCOUNTS, DEMO_DEFAULT_PASSWORD, meResponseSchema } from '@app/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { apiGet } from '../../lib/server-api';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  const me = await apiGet('/api/me', meResponseSchema);
  if (me.ok) redirect(me.data.membership ? '/inbox' : '/admin');

  // Mock mode is the local and demo setup: list the demo accounts so anyone can try it.
  const showDemo = (process.env['APP_MODE'] ?? 'mock') === 'mock';

  return (
    <main className="mx-auto w-full max-w-[440px] px-4 py-12 md:py-24">
      <div className="flex gap-4">
        {/* The custody margin: a person is about to hold the desk. */}
        <div aria-hidden className="w-1.5 shrink-0 bg-ballpoint" />
        <div className="flex-1">
          <p className="display text-headline">Support desk</p>
          <h1 className="mt-8 text-title font-semibold">Sign in</h1>
          <p className="mt-1 text-graphite">
            For staff of the business. Customers reach you on WhatsApp and never sign in here.
          </p>
          <SignInForm
            demo={
              showDemo ? { accounts: [...DEMO_ACCOUNTS], password: DEMO_DEFAULT_PASSWORD } : null
            }
          />
        </div>
      </div>
    </main>
  );
}
