'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { usePathname } from 'next/navigation';

export interface Section {
  href: string;
  label: string;
}

/**
 * Section links; the current one is underlined in ink (colour is reserved for
 * custody). Below 768 px there is no room for a row of links, so the current
 * section becomes a menu button.
 */
export function SectionNav({ sections }: { sections: Section[] }) {
  const pathname = usePathname();
  const current = sections.find((s) => pathname.startsWith(s.href));
  return (
    <>
      <nav aria-label="Sections" className="hidden gap-4 md:flex">
        {sections.map((section) => (
          <a
            key={section.href}
            href={section.href}
            aria-current={section === current ? 'page' : undefined}
            className={`font-semibold underline-offset-[15px] ${section === current ? 'underline decoration-2' : 'no-underline'}`}
          >
            {section.label}
          </a>
        ))}
      </nav>
      {sections.length > 1 ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="shrink-0 font-semibold md:hidden"
              aria-label="Sections"
            >
              {current?.label ?? 'Sections'} ▾
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={4}
              className="z-50 min-w-40 rounded-control border border-rule-strong bg-sheet p-1 shadow-[0_6px_20px_rgb(24_32_46_/_0.15)]"
            >
              {sections.map((section) => (
                <DropdownMenu.Item key={section.href} asChild>
                  <a
                    href={section.href}
                    aria-current={section === current ? 'page' : undefined}
                    className="block rounded-stamp px-2 py-1.5 font-semibold outline-none data-[highlighted]:bg-thermal"
                  >
                    {section.label}
                  </a>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}
    </>
  );
}
