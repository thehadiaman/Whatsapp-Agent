'use client';

import { INBOX_EVENT, INBOX_SOCKET_PATH, inboxEventSchema } from '@app/shared';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export type Connection =
  { status: 'connecting' } | { status: 'connected' } | { status: 'reconnecting'; since: Date };

export const CONNECTION_EVENT = 'desk:connection';

/**
 * Live updates. The socket only says *which* conversation changed; the inbox
 * refetches it through the API. After a reconnect everything is refetched,
 * because events sent while offline are lost.
 */
export function useInboxSocket(handlers: {
  onChange: (conversationId: string) => void;
  onReconnect: () => void;
}): Connection {
  const [connection, setConnection] = useState<Connection>({ status: 'connecting' });
  const latest = useRef(handlers);

  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    // Same origin: /api is proxied (Next.js in dev, Caddy in production).
    // No trailing slash: the Next.js rewrite would strip it anyway.
    const socket = io({ path: INBOX_SOCKET_PATH, addTrailingSlash: false });
    let wasDisconnected = false;

    const publish = (next: Connection) => {
      setConnection(next);
      window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: next }));
    };

    socket.on('connect', () => {
      publish({ status: 'connected' });
      if (wasDisconnected) latest.current.onReconnect();
      wasDisconnected = false;
    });
    socket.on('disconnect', () => {
      wasDisconnected = true;
      publish({ status: 'reconnecting', since: new Date() });
    });
    socket.on('connect_error', (error) => {
      if (error.message === 'unauthorized') {
        window.location.assign(new URL('/sign-in', window.location.origin).href);
      }
      if (!wasDisconnected) {
        wasDisconnected = true;
        publish({ status: 'reconnecting', since: new Date() });
      }
    });
    socket.on(INBOX_EVENT, (payload: unknown) => {
      const event = inboxEventSchema.safeParse(payload);
      if (event.success) latest.current.onChange(event.data.conversationId);
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  return connection;
}
