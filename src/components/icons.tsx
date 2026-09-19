/**
 * Device glyphs, drawn here rather than imported, so the app ships with no
 * third-party or vendor-trademarked artwork. All paths are on a 24x24 grid and
 * inherit `currentColor`.
 */
import type { DeviceType } from '../types/domain';
import { inkOn } from '../theme';

type P = { className?: string; style?: React.CSSProperties };
const S = (children: React.ReactNode) => (props: P) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={props.className}
    style={props.style}
    aria-hidden
  >
    {children}
  </svg>
);

const chassis = (
  <>
    <rect x="2" y="8" width="20" height="8" rx="1.5" />
    <path d="M5 12h2M9 12h2M13 12h2M17 12h2" />
  </>
);

/**
 * A glyph drawn twice, one box behind the other (LT-159): a stack, a chassis
 * pair or an HA cluster at a glance. Built from the ordinary glyph, so every
 * device type has one and none is drawn by hand twice.
 *
 * The box behind is masked out where the front one sits — both are outlines,
 * and two outlines crossing read as a tangle rather than as one in front. The
 * mask is the front glyph filled solid with a thick stroke, so it fits any
 * shape. Its id is per type, not per device: every copy of one type's mask is
 * identical, so which copy a page resolves the reference to does not matter.
 */
function stackedOf(type: DeviceType, Icon: (p: P) => JSX.Element) {
  const maskId = `cv-stacked-${type}`;
  // Scaled to 0.8 so two fit in the 24 box; the stroke is widened to match,
  // so a stacked glyph's lines are no thinner than a single one's.
  const back = 'translate(3.6 -0.6) scale(0.8)';
  const front = 'translate(0.4 4.4) scale(0.8)';
  const Stacked = (props: P) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={props.className}
      style={props.style}
      aria-hidden
      data-stacked=""
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="white" />
          <g transform={front}>
            {Icon({ style: { fill: 'black', stroke: 'black', strokeWidth: 4.5 } })}
          </g>
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <g transform={back}>{Icon({ style: { strokeWidth: 2 } })}</g>
      </g>
      <g transform={front}>{Icon({ style: { strokeWidth: 2 } })}</g>
    </svg>
  );
  return Stacked;
}

const stackedCache = new Map<DeviceType, (p: P) => JSX.Element>();

/** The stacked version of a device type's glyph (LT-159). */
export function stackedIcon(type: DeviceType): (p: P) => JSX.Element {
  let got = stackedCache.get(type);
  if (!got) {
    got = stackedOf(type, ICONS[type] ?? ICONS.generic);
    stackedCache.set(type, got);
  }
  return got;
}

export const ICONS: Record<DeviceType, (p: P) => JSX.Element> = {
  generic: S(
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h10M7 14h6" />
    </>,
  ),
  firewall: S(
    <>
      <path d="M3 5h18v6H3zM3 11h18v8H3z" />
      <path d="M9 5v6M15 5v6M6 11v8M12 11v8M18 11v8" />
    </>,
  ),
  router: S(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 9l-3 3 3 3M16 9l3 3-3 3M12 5v14" />
    </>,
  ),
  'core-switch': S(
    <>
      {chassis}
      <path d="M6 5h12M6 19h12" />
    </>,
  ),
  'distribution-switch': S(
    <>
      {chassis}
      <path d="M8 5h8" />
    </>,
  ),
  'access-switch': S(chassis),
  // LT-163: switch classes by layer rather than by role. Routed: arrows in
  // and out of the box; switched: an arrow across it.
  'l3-switch': S(
    <>
      {chassis}
      <path d="M12 2v4M10 4l2-2 2 2M12 22v-4M10 20l2 2 2-2" />
    </>,
  ),
  'l2-switch': S(
    <>
      {chassis}
      <path d="M5 4.5h14M7 2.5l-2 2 2 2M17 2.5l2 2-2 2" />
    </>,
  ),
  'wireless-controller': S(
    <>
      <rect x="2" y="9" width="20" height="8" rx="1.5" />
      <path d="M6 13h1.5M10 13h1.5" />
      <path d="M16 8.5a4 4 0 0 1 0 7M18.5 6a7 7 0 0 1 0 12" />
    </>,
  ),
  'access-point': S(
    <>
      <circle cx="12" cy="16" r="2.5" />
      <path d="M8.5 12.5a5 5 0 0 1 7 0M5.5 9.5a9 9 0 0 1 13 0" />
    </>,
  ),
  'ip-phone': S(
    <>
      <path d="M4 8c2.5-4 13.5-4 16 0l-2 2.5H6z" />
      <rect x="5" y="10.5" width="14" height="10.5" rx="2" />
      <path d="M9 14h.01M12 14h.01M15 14h.01M9 17.5h.01M12 17.5h.01M15 17.5h.01" />
    </>,
  ),
  'blade-chassis': S(
    <>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M6.5 6v12M10 6v12M13.5 6v12M17 6v12" />
    </>,
  ),
  'load-balancer': S(
    <>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M7.5 12H17M7.2 10.9l9.9-5M7.2 13.1l9.9 5" />
    </>,
  ),
  waf: S(
    <>
      <path d="M12 3l8 3v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6z" />
      <path d="M4.3 10.5h15.4M5.6 15h12.8M12 10.5V15M8.5 15v3.5M15.5 15v3.5" />
    </>,
  ),
  // LT-165: physical kit.
  rack: S(
    <>
      <rect x="5" y="2" width="14" height="20" rx="1" />
      <path d="M5 6.5h14M5 11h14M5 15.5h14M8 4.3h.01M8 8.8h.01M8 13.3h.01M8 17.8h.01" />
    </>,
  ),
  'patch-panel': S(
    <>
      <rect x="2" y="8" width="20" height="8" rx="1" />
      <path d="M4.5 11h2.5v2.5H4.5zM9 11h2.5v2.5H9zM13 11h2.5v2.5H13zM17.5 11H20v2.5h-2.5z" />
    </>,
  ),
  pdu: S(
    <>
      <rect x="8" y="2" width="8" height="20" rx="1.5" />
      <path d="M11 5.5v2M13 5.5v2M11 11v2M13 11v2M11 16.5v2M13 16.5v2" />
    </>,
  ),
  ups: S(
    <>
      <rect x="4" y="4" width="16" height="17" rx="2" />
      <path d="M9 2h6M13 8l-3 5h4l-3 5" />
    </>,
  ),
  'vm-host': S(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="6" y="6" width="5" height="5" rx="0.8" />
      <rect x="13" y="6" width="5" height="5" rx="0.8" />
      <rect x="6" y="13" width="5" height="5" rx="0.8" />
      <rect x="13" y="13" width="5" height="5" rx="0.8" />
    </>,
  ),
  server: S(
    <>
      <rect x="4" y="3" width="16" height="7" rx="1.5" />
      <rect x="4" y="14" width="16" height="7" rx="1.5" />
      <path d="M8 6.5h.01M8 17.5h.01" />
    </>,
  ),
  vm: S(
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M9 9l4 2-4 2z" />
      <path d="M8 21h8" />
    </>,
  ),
  storage: S(
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>,
  ),
  endpoint: S(
    <>
      <rect x="3" y="5" width="18" height="11" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </>,
  ),
  printer: S(
    <>
      <path d="M7 9V4h10v5" />
      <rect x="3" y="9" width="18" height="7" rx="1.5" />
      <path d="M7 14h10v6H7z" />
    </>,
  ),
  camera: S(
    <>
      <path d="M3 8l14-3 2 6-14 3z" />
      <path d="M8 14v4a2 2 0 0 0 4 0" />
      <circle cx="15" cy="10" r="1" />
    </>,
  ),
  internet: S(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>,
  ),
  'private-cloud': S(
    <>
      <path d="M7 18a4 4 0 0 1 .6-8 5.5 5.5 0 0 1 10.6 1.6A3.4 3.4 0 0 1 17.5 18z" />
      <path d="M10 14h4" />
    </>,
  ),
  site: S(
    <>
      <path d="M3 20V9l9-5 9 5v11" />
      <path d="M9 20v-6h6v6" />
    </>,
  ),
  vpn: S(
    <>
      <path d="M9 15l-2.5 2.5a3.5 3.5 0 0 1-5-5L4 10" />
      <path d="M15 9l2.5-2.5a3.5 3.5 0 0 1 5 5L20 14" />
      <path d="M9 15l6-6" />
    </>,
  ),
  // LT-164: a provider's MPLS core — a cloud with a mesh in it, so it does not
  // read as the internet or a private cloud.
  'mpls-cloud': S(
    <>
      <path d="M7 18a4 4 0 0 1 .6-8 5.5 5.5 0 0 1 10.6 1.6A3.4 3.4 0 0 1 17.5 18z" />
      <path d="M10.2 14.6h3.6M9.9 14l1.5-2M14.1 14l-1.5-2" />
      <circle cx="9.3" cy="14.9" r="0.9" />
      <circle cx="14.7" cy="14.9" r="0.9" />
      <circle cx="12" cy="11.2" r="0.9" />
    </>,
  ),
  application: S(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </>,
  ),
  database: S(
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>,
  ),
  'custom-image': S(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5-5-9 9" />
    </>,
  ),
  rectangle: S(<rect x="3" y="6" width="18" height="12" />),
  rounded: S(<rect x="3" y="6" width="18" height="12" rx="4" />),
  circle: S(<circle cx="12" cy="12" r="8" />),
  diamond: S(<path d="M12 3l9 9-9 9-9-9z" />),
  cloud: S(<path d="M7 18a4 4 0 0 1 .6-8 5.5 5.5 0 0 1 10.6 1.6A3.4 3.4 0 0 1 17.5 18z" />),
  text: S(<path d="M5 6h14M12 6v13M9 19h6" />),
  callout: S(
    <>
      <rect x="3" y="4" width="13" height="10" rx="2" />
      <path d="M16 12l5 8" />
      <circle cx="21" cy="20" r="1.4" />
    </>,
  ),
  zone: S(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" strokeDasharray="3 2" />
      <path d="M3 9h18" />
    </>,
  ),
};

/**
 * A device's glyph as it is drawn, on the canvas and in export alike: stacked
 * or single (LT-159), outline or solid (LT-168).
 *
 * Solid is Coreview's own "iconic" style — the device's colour as a rounded
 * tile with the glyph over it in whichever ink reads on that colour. Not a
 * vendor's style (D-028); the same shape, filled.
 */
export function DeviceGlyph({
  type,
  stacked = false,
  solid = false,
  color,
  className,
  style,
}: {
  type: DeviceType;
  stacked?: boolean;
  solid?: boolean;
  /** Needed for solid: the tile's fill, and what the ink is chosen against. */
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const Icon = stacked ? stackedIcon(type) : (ICONS[type] ?? ICONS.generic);
  if (!solid || !color) return <Icon className={className} style={style} />;
  const ink = inkOn(color);
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden data-solid="">
      <rect x="0.5" y="0.5" width="23" height="23" rx="5" fill={color} />
      <g transform="translate(3.6 3.6) scale(0.7)">{Icon({ style: { color: ink, strokeWidth: 2.2 } })}</g>
    </svg>
  );
}

export const DEVICE_LABEL: Record<DeviceType, string> = {
  generic: 'Generic device',
  firewall: 'Firewall',
  router: 'Router',
  'core-switch': 'Core switch',
  'distribution-switch': 'Distribution switch',
  'access-switch': 'Access switch',
  'l3-switch': 'L3 switch',
  'l2-switch': 'L2 switch',
  'wireless-controller': 'Wireless controller',
  'access-point': 'Wireless AP',
  'ip-phone': 'IP phone',
  'blade-chassis': 'Blade chassis',
  'load-balancer': 'Load balancer',
  waf: 'Web application firewall',
  server: 'Server',
  vm: 'Virtual machine',
  'vm-host': 'VM host',
  storage: 'Storage',
  endpoint: 'Endpoint / client',
  printer: 'Printer',
  camera: 'Camera / IoT',
  internet: 'ISP / Internet',
  'private-cloud': 'Private cloud',
  site: 'Data centre / site',
  vpn: 'VPN / tunnel',
  'mpls-cloud': 'MPLS cloud',
  rack: 'Rack',
  'patch-panel': 'Patch panel',
  pdu: 'PDU',
  ups: 'UPS',
  application: 'Application / service',
  database: 'Database',
  'custom-image': 'Custom image',
  rectangle: 'Rectangle',
  rounded: 'Rounded rectangle',
  circle: 'Circle',
  diamond: 'Diamond',
  cloud: 'Cloud',
  zone: 'Section',
  callout: 'Callout',
  text: 'Text',
};

export const PALETTE_GROUPS: Array<{ title: string; items: DeviceType[] }> = [
  {
    title: 'Network',
    items: [
      'firewall',
      'router',
      'core-switch',
      'distribution-switch',
      'access-switch',
      'l3-switch',
      'l2-switch',
      'wireless-controller',
      'access-point',
      'load-balancer',
      'waf',
      'vpn',
    ],
  },
  {
    title: 'Compute and services',
    items: [
      'server',
      'vm-host',
      'vm',
      'blade-chassis',
      'storage',
      'application',
      'database',
      'endpoint',
      'ip-phone',
      'printer',
      'camera',
    ],
  },
  { title: 'Physical', items: ['rack', 'patch-panel', 'pdu', 'ups'] },
  { title: 'Sites and clouds', items: ['internet', 'mpls-cloud', 'private-cloud', 'site', 'generic'] },
  {
    title: 'Shapes',
    items: ['zone', 'callout', 'rectangle', 'rounded', 'circle', 'diamond', 'cloud', 'text', 'custom-image'],
  },
];
