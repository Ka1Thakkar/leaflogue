import type { SVGProps } from "react";

/**
 * Leaflogue's own icon set: a few strokes each, drawn for the stat sheet.
 * Every path sits on a 24×24 grid and inherits the text colour.
 */
const PATHS = {
  library: <path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h13" />,
  passages: <path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6" />,
  threads: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="12" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8.5 6.5 15.5 11M8.5 17.5l7-4.5" /></>,
  statistics: <path d="M5 20V10M12 20V4M19 20v-7" />,
  import: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  shuffle: <path d="M3 7h3l9 10h6M3 17h3l3-3.5M15 7h6M18 4l3 3-3 3M18 14l3 3-3 3" />,
  open: <path d="M7 17 17 7M9 7h8v8" />,
  note: <path d="M4 20h4L19 9l-4-4L4 16v4Z" />,
  more: <><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></>,
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  published: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></>,
  back: <path d="m15 6-6 6 6 6" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  explain: <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z" />,
  profile: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  "sign-out": <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4" />,
  "note-paper": <path d="M5 4h14v10l-6 6H5ZM13 20v-6h6" />,
  trash: <path d="M4 7h16M10 7V4h4v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  "check-all": <path d="m2 12.5 4.5 4.5L16 7M12 16l1 1 9-10" />,
  tag: <><path d="M3 12V4h8l10 10-8 8Z" /><circle cx="7.5" cy="8.5" r="1.3" /></>,
  sync: <path d="M20 11a8 8 0 0 0-14.3-4.6L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.6L20 16M20 20v-4h-4" />,
  leaf: <path d="M5 19C5 10 10 5 20 5c0 10-5 15-14 15M5 19l8-8" />,
  history: <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6M4 4v4.6h4.6M12 8v4l3 2" />,
  "folder-open": <path d="M3 18V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2M3 18l3-8h16l-3 8Z" />,
  upload: <path d="M12 16V5M7 10l5-5 5 5M5 20h14" />,
  calendar: <path d="M4 6h16v14H4ZM4 10h16M8 3v4M16 3v4" />,
  "arrow-left": <path d="M19 12H5M11 6l-6 6 6 6" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  sort: <path d="M4 6h10M4 12h7M4 18h4M17 5v14M14 16l3 3 3-3" />,
  archive: <path d="M3 5h18v4H3ZM5 9v10h14V9M10 13h4" />,
  restore: <path d="M3 5h18v4H3ZM5 9v10h14V9M12 17v-6M9 14l3-3 3 3" />,
  reader: <path d="M7 3h10v18H7ZM10 18h4" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  save: <path d="M5 4h11l3 3v13H5ZM8 4v5h7V4M8 20v-6h8v6" />,
  rows: <path d="M4 5h16v14H4ZM4 10h16M4 15h16" />,
  reset: <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6M4 4v4.6h4.6" />,
  palette: <><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.9 2-2 0-1.6-1.5-2.5 0-3.5.8-.5 2-.5 3.5-.5A3.5 3.5 0 0 0 21 11.5C21 6.8 17 3 12 3Z" /><circle cx="7.5" cy="11" r="1.1" /><circle cx="10" cy="7" r="1.1" /><circle cx="15" cy="7.5" r="1.1" /></>,
  disk: <path d="M3 13l3-8h12l3 8v6H3ZM3 13h18M7 16h3" />,
  merge: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 7v10M6 7c0 4 4 5 10 5" /></>,
  database: <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
  cloud: <path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11.5 3.3 3.3 0 0 0 7 18Z" />,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-up": <path d="m6 15 6-6 6 6" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  book: <path d="M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3ZM21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7Z" />,
  bell: <path d="M6 16v-5a6 6 0 1 1 12 0v5l2 2H4ZM10 20a2 2 0 0 0 4 0" />,
  funnel: <path d="M4 5h16l-6 8v6l-4-2v-4Z" />,
  grip: <><circle cx="9" cy="6" r="1.2" /><circle cx="15" cy="6" r="1.2" /><circle cx="9" cy="12" r="1.2" /><circle cx="15" cy="12" r="1.2" /><circle cx="9" cy="18" r="1.2" /><circle cx="15" cy="18" r="1.2" /></>,
  layout: <path d="M4 4h7v9H4ZM13 4h7v5h-7ZM13 11h7v9h-7ZM4 15h7v5H4Z" />,
  sidebar: <path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 4v16" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 17, strokeWidth = 1.8, ...rest }: { readonly name: IconName; readonly size?: number; readonly strokeWidth?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {PATHS[name]}
    </svg>
  );
}
