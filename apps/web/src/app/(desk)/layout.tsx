import { meResponseSchema } from '@app/shared';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { apiGet } from '../../lib/server-api';
import { ConnectionStatus } from './connection-status';
import { SectionNav } from './section-nav';
import { SectionShortcuts } from './section-shortcuts';
import { SignOutButton } from './sign-out-button';

export const dynamic = 'force-dynamic';

/** Signed-in shell: top bar with the business, sections and the person at the desk. */
export default async function DeskLayout({ children }: { children: ReactNode }) {
  const me = await apiGet('/api/me', meResponseSchema);
  if (!me.ok) redirect('/sign-in');

  const { user, membership } = me.data;
  const sections = membership
    ? [
        { href: '/inbox', label: 'Inbox' },
        { href: '/knowledge', label: 'Knowledge' },
        { href: '/analytics', label: 'Analytics' },
        { href: '/settings', label: 'Settings' },
      ]
    : [{ href: '/admin', label: 'Businesses' }];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 items-center gap-3 border-b border-rule bg-sheet px-4 md:gap-6">
        {/* 20px: the condensed display face blurs at smaller sizes on 1x screens. */}
        <span className="display truncate text-pane">
          {membership?.tenantName ?? 'Platform admin'}
        </span>
        <SectionNav sections={sections} />
        {membership ? <SectionShortcuts /> : null}
        <div className="ml-auto flex items-center gap-3">
          {membership ? <ConnectionStatus /> : null}
          <span className="hidden text-list sm:inline">{user.name}</span>
          <span className="mono text-meta text-graphite">
            {membership?.role ?? 'platform admin'}
          </span>
          <SignOutButton />
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
