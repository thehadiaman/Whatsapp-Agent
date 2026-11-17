'use client';

import { usePathname } from 'next/navigation';

export interface Section {
  href: string;
  label: string;
}

/** Section links; the current one is underlined in ink (colour is reserved for custody). */
export function SectionNav({ sections }: { sections: Section[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections" className="hidden gap-4 md:flex">
      {sections.map((section) => {
        const current = pathname.startsWith(section.href);
        return (
          <a
            key={section.href}
            href={section.href}
            aria-current={current ? 'page' : undefined}
            className={`font-semibold underline-offset-[15px] ${current ? 'underline decoration-2' : 'no-underline'}`}
          >
            {section.label}
          </a>
        );
      })}
    </nav>
  );
}
