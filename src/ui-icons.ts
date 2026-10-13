import { html, raw } from 'hono/html';

type Fragment = ReturnType<typeof html>;

/** Line icons, drawn in the current text color. */
const ICONS: Record<string, string> = {
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2 2M15 8l2 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  package: '<path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  terminal: '<path d="m6 9 3 3-3 3M12 15h6"/><rect x="2" y="3" width="20" height="18" rx="3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  pencil: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pin: '<path d="M12 17v5M9 10.8V4h6v6.8l2 2.2v2H7v-2Z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  sprout: '<path d="M12 21v-8"/><path d="M12 13c0-4.5 3-7.5 8-7.5 0 5-3 7.5-8 7.5Z"/><path d="M12 15.5c0-3.4-2.4-6-6.5-6 0 4 2.4 6 6.5 6Z"/>',
  fence: '<path d="M5 21V8l2-3 2 3v13M15 21V8l2-3 2 3v13M3 11h18M3 17h18"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 17a9 9 0 1 1 17.4 0"/><path d="M12 14h.01"/>',
  heart: '<path fill="currentColor" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 7.7 8 9 4.6-1.3 8-4.5 8-9V6Z"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  logs: '<path d="M4 6h16M4 10h16M4 14h10M4 18h7"/>',
  power: '<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8M14.7 6.3 13 4.7a4 4 0 0 0-5 5L3 15l3 3 5.3-5.3"/>',
};

const SIZES = { xs: 'size-3', sm: 'size-4', md: 'size-[18px]' } as const;

export function icon(name: string, size: 'xs' | 'sm' | 'md' = 'md'): Fragment {
  return html`<svg class="${SIZES[size]} shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICONS[name] ?? '')}</svg>`;
}

/** The A1 mark: the server's face, readable down to 16 px. */
export const LOGO = raw('<img src="/apple-touch-icon.png" width="36" height="36" alt="" class="size-9 shrink-0 object-contain" />');

/** The mascot's moods, each drawn in static/mascots/; `yard` is the logo itself. */
export const MOODS = ['sleeping', 'worried', 'busy', 'celebrating', 'lost', 'hello'] as const;
export type Mood = (typeof MOODS)[number] | 'yard';

/** The mascot from the logo, for the moments the UI is empty, waiting, busy or lost. */
export function mascot(size: 'xs' | 'sm' | 'md' | 'lg' = 'md', mood: Mood = 'yard'): Fragment {
  const px = { xs: 40, sm: 56, md: 120, lg: 160 }[size];
  return html`<img src="${mood === 'yard' ? '/icon.png' : `/mascots/${mood}.png`}" width="${px}" height="${px}" alt="" class="shrink-0 select-none drop-shadow-sm" />`;
}
