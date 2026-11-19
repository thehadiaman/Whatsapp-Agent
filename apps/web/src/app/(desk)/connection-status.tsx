'use client';

import { useEffect, useState } from 'react';
import { CONNECTION_EVENT, type Connection } from '../../inbox/use-inbox-socket';

/** "Live" or "Reconnecting…" in the top bar, fed by the inbox's socket. */
export function ConnectionStatus() {
  const [connection, setConnection] = useState<Connection | null>(null);
  useEffect(() => {
    const onChange = (event: Event) => {
      setConnection((event as CustomEvent<Connection>).detail);
    };
    window.addEventListener(CONNECTION_EVENT, onChange);
    return () => {
      window.removeEventListener(CONNECTION_EVENT, onChange);
    };
  }, []);
  if (!connection) return null;
  return (
    <span
      role="status"
      className={`mono hidden text-meta sm:inline ${connection.status === 'reconnecting' ? 'text-stamp' : 'text-graphite'}`}
    >
      {connection.status === 'connected'
        ? 'Live'
        : connection.status === 'connecting'
          ? 'Connecting…'
          : 'Reconnecting…'}
    </span>
  );
}
