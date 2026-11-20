import { meResponseSchema } from '@app/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Knowledge } from '../../../knowledge/knowledge';
import { apiGet } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'Knowledge' };
export const dynamic = 'force-dynamic';

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { s } = await searchParams;
  const initialSourceId = typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s) ? s : null;
  const me = await apiGet('/api/me', meResponseSchema);
  if (!me.ok) redirect('/sign-in');
  if (!me.data.membership) redirect('/admin');
  return (
    <Knowledge isOwner={me.data.membership.role === 'owner'} initialSourceId={initialSourceId} />
  );
}
