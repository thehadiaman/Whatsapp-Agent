import { meResponseSchema } from '@app/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { apiGet } from '../../../lib/server-api';
import { Settings } from '../../../settings/settings';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const me = await apiGet('/api/me', meResponseSchema);
  if (!me.ok) redirect('/sign-in');
  if (!me.data.membership) redirect('/admin');
  return <Settings isOwner={me.data.membership.role === 'owner'} meId={me.data.user.id} />;
}
