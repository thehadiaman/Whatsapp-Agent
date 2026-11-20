import type { Metadata } from 'next';
import { LinkForm } from '../../../links/link-form';

export const metadata: Metadata = { title: 'Reset password' };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto w-full max-w-[440px] px-4 py-12 md:py-24">
      <div className="flex gap-4">
        <div aria-hidden className="w-1.5 shrink-0 bg-ballpoint" />
        <div className="flex-1">
          <p className="display text-headline">Support desk</p>
          <h1 className="mt-8 text-title font-semibold">Reset your password</h1>
          <LinkForm kind="reset" token={token} />
        </div>
      </div>
    </main>
  );
}
