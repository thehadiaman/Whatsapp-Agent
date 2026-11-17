import { meResponseSchema } from '@app/shared';
import { redirect } from 'next/navigation';
import { apiGet } from '../lib/server-api';

export const dynamic = 'force-dynamic';

/** Sends each person to where they work: staff to the inbox, platform admins to the business list. */
export default async function HomePage() {
  const me = await apiGet('/api/me', meResponseSchema);
  if (!me.ok) redirect('/sign-in');
  redirect(me.data.membership ? '/inbox' : '/admin');
}
