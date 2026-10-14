/** Small stroke icon set (24px grid, currentColor) for navigation and toolbars. Decorative: always aria-hidden. */
import { cn } from "@/lib/cn";

const PATHS = {
  today: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  people: "M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a3 3 0 100-6 3 3 0 000 6M22 19v-1a4 4 0 00-3-3.9M16 4.1a3 3 0 010 5.8",
  schedule: "M3 6h18v15H3zM3 10h18M8 3v4M16 3v4M7 14h3M7 17h3M14 14h3",
  billing: "M2 6h20v12H2zM2 10h20M6 15h4",
  training: "M6 7v10M18 7v10M3 9v6M21 9v6M6 12h12",
  science: "M3 20h18M6 16l4-6 4 3 5-8",
  performance: "M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z",
  messages: "M4 5h16v11H8l-4 4z",
  documents: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6",
  reports: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  payroll: "M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
  imports: "M12 3v12M7 10l5 5 5-5M4 21h16",
  kiosk: "M5 3h14v14H5zM9 21h6M12 17v4M9 10l2 2 4-4",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14M21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
  chevron: "M6 9l6 6 6-6",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18M12 7v5l3 2",
  logout: "M9 21H5V3h4M16 17l5-5-5-5M21 12H9",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={cn("size-5 shrink-0", className)}>
      <path d={PATHS[name]} />
    </svg>
  );
}
