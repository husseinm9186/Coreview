/**
 * The chrome's own glyphs: one set, on a 16 px grid, 1.5 px strokes with
 * round caps, drawn in `currentColor` so a button's colour is the icon's.
 *
 * Before this the chrome borrowed Unicode symbols (✎ ▤ ▣ ⌕ ⋯ ▸) whose
 * weight and baseline depend on whichever font the machine falls back to,
 * so the same button looked different on every desktop. These do not. The
 * device glyphs on the canvas are a different set and live in icons.tsx.
 */
export type ChromeIconName =
  | 'zoom-in' | 'zoom-out' | 'fit' | 'grid' | 'snap' | 'ground' | 'page'
  | 'pen' | 'eraser' | 'types' | 'arrange' | 'filter' | 'overview'
  | 'undo' | 'redo' | 'save' | 'search' | 'help' | 'more'
  | 'chevron-down' | 'chevron-right' | 'chevron-up' | 'check' | 'x' | 'alert'
  | 'note' | 'sticky' | 'pop-out' | 'maximise' | 'hide' | 'play' | 'stop'
  | 'plus' | 'minus' | 'lock' | 'pin' | 'terminal' | 'backup' | 'find'
  | 'import' | 'export' | 'eye' | 'eye-off' | 'menu' | 'settings' | 'copy';

/** Each glyph as the children of a 16×16 SVG. A filled part says so. */
const GLYPHS: Record<ChromeIconName, JSX.Element> = {
  'zoom-in': <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5M7 5v4M5 7h4" /></>,
  'zoom-out': <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5M5 7h4" /></>,
  fit: <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />,
  grid: <><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><path d="M2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11" opacity="0.7" /></>,
  snap: <path d="M4.5 2v6a3.5 3.5 0 0 0 7 0V2M2.5 5.5h4M9.5 5.5h4" />,
  ground: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M8 2.5h5.5v11H8z" fill="currentColor" stroke="none" opacity="0.4" /></>,
  page: <path d="M4 2.5h5.5l3 3v8H4zM9.5 2.5v3h3" />,
  pen: <path d="m3 13 1-4 7.5-7.5a1.4 1.4 0 0 1 2 2L6 11zM10 3l3 3" />,
  eraser: <path d="m9.5 2.5 4 4-6 6H5l-2.5-2.5 7-7.5zM5 12.5h8" />,
  types: <path d="M2 4h12M2 8h3M7 8h3M12 8h2M2 12h2M6 12h2M10 12h2" />,
  arrange: <><rect x="2.5" y="2.5" width="11" height="3" rx="0.8" /><rect x="2.5" y="7.5" width="5" height="3" rx="0.8" /><rect x="9" y="7.5" width="4.5" height="3" rx="0.8" /><path d="M2.5 13h11" /></>,
  filter: <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" />,
  overview: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><rect x="8" y="7" width="4" height="4" rx="0.5" /></>,
  undo: <path d="M6 4 2.5 7.5 6 11M3 7.5h7a3.5 3.5 0 0 1 0 7H8" />,
  redo: <path d="m10 4 3.5 3.5L10 11M13 7.5H6a3.5 3.5 0 0 0 0 7h2" />,
  save: <path d="M3 2.5h8l2.5 2.5v8.5H3zM5 2.5v4h5v-4M5 13.5v-4h6v4" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></>,
  help: <><circle cx="8" cy="8" r="6.5" /><path d="M6 6.2a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6M8 12h.01" /></>,
  more: <g fill="currentColor" stroke="none"><circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /></g>,
  'chevron-down': <path d="m4 6 4 4 4-4" />,
  'chevron-right': <path d="m6 4 4 4-4 4" />,
  'chevron-up': <path d="m4 10 4-4 4 4" />,
  check: <path d="m3 8.5 3 3 7-7" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  alert: <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.2h.01" />,
  note: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M5 6h6M5 9h4" /></>,
  sticky: <path d="M2.5 2.5h11v7l-4 4h-7zM9.5 13.5v-4h4" />,
  'pop-out': <path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7 9" />,
  maximise: <path d="M9 2h5v5M7 14H2V9M14 2 9 7M2 14l5-5" />,
  hide: <path d="m3 6 5 5 5-5" />,
  play: <path d="m4 2.5 9 5.5-9 5.5z" fill="currentColor" stroke="none" />,
  stop: <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" stroke="none" />,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  lock: <><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></>,
  pin: <path d="M8 2v6M5 8h6l-1 3H6zM8 11v3" />,
  terminal: <><rect x="2.5" y="3.5" width="11" height="9" rx="1" /><path d="m5 7 2 1.5L5 10M8.5 10h3" /></>,
  backup: <><rect x="3" y="3" width="10" height="3.5" rx="1" /><rect x="3" y="9.5" width="10" height="3.5" rx="1" /><path d="M5.5 4.75h.01M5.5 11.25h.01" /></>,
  find: <><circle cx="8" cy="8" r="4" /><path d="M8 2v2M8 12v2M2 8h2M12 8h2" /></>,
  import: <path d="M8 2v8M5 7l3 3 3-3M3 13h10" />,
  export: <path d="M8 10V2M5 5l3-3 3 3M3 13h10" />,
  eye: <><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  'eye-off': <><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><path d="m3 3 10 10" /></>,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  settings: <><circle cx="8" cy="8" r="2" /><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M3.8 12.2l1-1M11.2 4.8l1-1" /></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
};

export const CHROME_ICON_NAMES = Object.keys(GLYPHS) as ChromeIconName[];

/** One glyph, decorative: the button it sits in carries the name. */
export function ChromeIcon({ name, size = 16, className }: { name: ChromeIconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}

/**
 * A 28 px ghost button with an icon and a name that screen readers and
 * tests read while the eye reads the glyph. A toggle says its state with
 * `aria-pressed` and a fill, never by rewriting its name.
 */
export function IconButton({
  icon, label, shortcut, pressed, disabled, onClick, className, region, word,
}: {
  icon: ChromeIconName;
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  /** A `data-region` for the harnesses. */
  region?: string;
  /** A visible word beside the glyph, for the few buttons that need one. */
  word?: string;
}) {
  return (
    <button
      type="button"
      className={`cv-icon-btn${pressed ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      onClick={onClick}
      data-region={region}
    >
      <ChromeIcon name={icon} />
      {word ? <span className="cv-icon-word">{word}</span> : null}
      <span className="cv-sr">{label}</span>
    </button>
  );
}
