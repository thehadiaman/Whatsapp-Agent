'use client';

import { useEffect } from 'react';

const TARGETS: Record<string, string> = {
  i: '/inbox',
  k: '/knowledge',
  a: '/analytics',
  s: '/settings',
};

/**
 * `g` then `i`/`k`/`a`/`s` switches sections (DESIGN.md "Keyboard first").
 * It listens in the capture phase so the second key never reaches a page's
 * own shortcuts (in the inbox, `a` assigns and `k` moves up).
 */
export function SectionShortcuts() {
  useEffect(() => {
    let armedAt = 0;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (armedAt && Date.now() - armedAt < 1_500) {
        armedAt = 0;
        const href = TARGETS[key];
        if (href) {
          event.preventDefault();
          event.stopImmediatePropagation();
          window.location.assign(href);
        }
        return;
      }
      if (key === 'g') {
        armedAt = Date.now();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  return null;
}
