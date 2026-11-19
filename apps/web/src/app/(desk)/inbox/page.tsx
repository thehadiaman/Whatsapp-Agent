import { meResponseSchema } from '@app/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Inbox } from '../../../inbox/inbox';
import { apiGet } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { c } = await searchParams;
  const initialSelectedId = typeof c === 'string' && /^[0-9a-f-]{36}$/i.test(c) ? c : null;
  const me = await apiGet('/api/me', meResponseSchema);
  if (!me.ok) redirect('/sign-in');
  if (!me.data.membership) redirect('/admin');
  return (
    <Inbox
      me={{ id: me.data.user.id, name: me.data.user.name, role: me.data.membership.role }}
      initialSelectedId={initialSelectedId}
    />
  );
}
