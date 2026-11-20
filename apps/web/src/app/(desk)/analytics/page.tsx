import { meResponseSchema } from '@app/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Analytics } from '../../../analytics/analytics';
import { apiGet } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'Analytics' };
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const me = await apiGet('/api/me', meResponseSchema);
  if (!me.ok) redirect('/sign-in');
  if (!me.data.membership) redirect('/admin');
  return <Analytics />;
}
