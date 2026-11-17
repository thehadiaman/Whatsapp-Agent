import { platformTenantSchema } from '@app/shared';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { apiGet } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'Businesses' };

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

/** Platform admins see which businesses exist, never what is inside them. */
export default async function AdminPage() {
  const result = await apiGet('/api/admin/tenants', z.array(platformTenantSchema));
  if (!result.ok) redirect('/inbox');

  return (
    <main className="mx-auto max-w-[880px] px-4 py-10">
      <h1 className="text-title font-semibold">Businesses</h1>
      <p className="mt-1 text-graphite">
        {result.data.length} on this platform. Their conversations and settings are visible only to
        their own staff.
      </p>
      <table className="mt-6 w-full border-y border-rule text-left text-list">
        <thead className="text-label text-graphite">
          <tr>
            <th className="py-2 font-semibold">Business</th>
            <th className="py-2 font-semibold">Address</th>
            <th className="py-2 text-right font-semibold">Staff</th>
            <th className="py-2 text-right font-semibold">Joined</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule border-t border-rule">
          {result.data.map((tenant) => (
            <tr key={tenant.id}>
              <td className="py-2 font-semibold">{tenant.name}</td>
              <td className="mono py-2 text-meta text-graphite">{tenant.slug}</td>
              <td className="mono py-2 text-right">{tenant.members}</td>
              <td className="mono py-2 text-right text-meta">
                {dateFormat.format(new Date(tenant.createdAt))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
