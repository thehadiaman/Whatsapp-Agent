import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Inbox' };

// The three-pane inbox arrives in phase 3; until then this is its empty state.
export default function InboxPage() {
  return (
    <main className="mx-auto max-w-[640px] px-4 py-16">
      <div className="flex gap-4">
        <div aria-hidden className="w-0.5 shrink-0 bg-graphite" />
        <div>
          <h1 className="text-title font-semibold">No conversations yet</h1>
          <p className="mt-1 text-graphite">
            Customer messages from WhatsApp appear here as soon as your number is connected. The
            assistant answers first; you can take over any conversation.
          </p>
        </div>
      </div>
    </main>
  );
}
