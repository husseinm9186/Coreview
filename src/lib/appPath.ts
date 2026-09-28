/**
 * An application's path, as a page of its own (LT-348).
 *
 * LT-346 works out where a packet goes. This turns that answer into something
 * an engineer can hand to somebody: a small diagram of just the path, an
 * ordered list of what it passes through, a narrative of why, and a report.
 *
 * **The original topology is never touched, and that is structural rather than
 * careful.** Everything here builds *new* nodes and edges from a `TraceResult`
 * and returns them; nothing takes an existing page, and nothing returns a
 * mutation. The page it produces is created through the Pages system that
 * already exists (`withNewPage`), so it renames, saves, exports and deletes
 * like any other page — and generating a second application makes a second
 * page rather than editing the first.
 *
 * **It draws only the path.** On a network of hundreds of devices the point is
 * that this page holds the eight that matter. Nothing is copied from the source
 * page; the nodes here are made from the trace.
 *
 * **Nothing is invented.** Where the trace could not resolve a section, the
 * diagram gets an explicit unresolved node carrying the reason, because a gap
 * drawn as a line is a lie and a gap drawn as a gap is information.
 */
import { uid } from './id';
import type { Hop, HopSegment, TraceResult } from './pathTrace';
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData, DeviceType, LinkData } from '../types/domain';

/** What is being traced, in the words of whoever asked. */
export interface Application {
  /** "Customer Portal". Optional — a path is still a path without a name. */
  name?: string;
  source: string;
  destination: string;
  /** `tcp`, `udp`, `icmp`. */
  protocol?: string;
  port?: number | null;
  vrf?: string;
}

/** One entry in the ordered list the report prints. */
export interface AppStep {
  order: number;
  device: string;
  /** The interface traffic leaves by, where the device said. */
  interface: string | null;
  /** The route that was chosen. */
  prefix: string | null;
  /** The routing protocol that put it there. */
  protocol: string | null;
  nextHop: string | null;
  distance: number | null;
  metric: number | null;
  /** Why this route, in one sentence. */
  why: string;
  /** Recursive resolution, where the next hop needed it. */
  resolvedThrough: string[];
  /** The VRF the decision was made in, when not the global table. */
  vrf: string | null;
  /** What kind of step this is, when it is not a plain routed hop. */
  segment: HopSegment | null;
  /** BGP's own tie-breakers, where the device reported them. */
  bgp: Hop['bgp'] | null;
}

/** The glyph and colour a step is drawn with, by what kind of step it is. */
function lookOf(hop: Hop): { type: DeviceType; prefix: string } {
  switch (hop.segment?.kind) {
    case 'nat':
      return { type: 'firewall', prefix: 'NAT' };
    case 'vip':
      return { type: 'load-balancer', prefix: 'VIP' };
    case 'overlay':
      return { type: 'core-switch', prefix: 'VTEP' };
    case 'decapsulate':
      return { type: 'core-switch', prefix: 'VTEP' };
    case 'underlay':
      return { type: 'router', prefix: 'underlay' };
    case 'otv':
      return { type: 'core-switch', prefix: 'OTV' };
    default:
      return { type: 'router', prefix: '' };
  }
}

const ROW = 150;
const COLUMN = 260;

/** How wide a generated node is drawn. Matches what `buildTopology` uses. */
const NODE = { width: 176, height: 96 };

/** What the arrow into a step is labelled with. */
function edgeLabel(hop: Hop, first: string | null): string {
  if (first) return first;
  switch (hop.segment?.kind) {
    case 'nat':
      return 'NAT';
    case 'vip':
      return 'VIP';
    case 'overlay':
      return `VNI ${hop.segment.vni}`;
    case 'underlay':
      return 'underlay';
    case 'decapsulate':
      return `VNI ${hop.segment.vni}`;
    case 'otv':
      return `OTV VLAN ${hop.segment.vlan}`;
    default:
      return hop.prefix;
  }
}

/** The flow as a label: `TCP/443`, or just the protocol. */
export function flowLabel(app: Application): string {
  const protocol = (app.protocol ?? '').trim().toUpperCase();
  if (!protocol) return app.port ? `port ${app.port}` : 'any';
  return app.port ? `${protocol}/${app.port}` : protocol;
}

/**
 * What the generated page is called.
 *
 * `APP - Customer Portal - TCP 443`, which sorts next to its siblings in the
 * page tabs and says what it is without being opened.
 */
export function applicationPageName(app: Application): string {
  const parts = ['APP'];
  const name = (app.name ?? '').trim();
  parts.push(name || `${app.source.trim()} → ${app.destination.trim()}`);
  const protocol = (app.protocol ?? '').trim().toUpperCase();
  if (protocol) parts.push(app.port ? `${protocol} ${app.port}` : protocol);
  return parts.join(' - ');
}

/** The ordered list of what one path goes through. */
export function applicationSteps(path: readonly Hop[]): AppStep[] {
  return path.map((hop, i) => ({
    order: i + 1,
    device: hop.device,
    interface: hop.outInterface,
    prefix: hop.prefix,
    protocol: hop.protocol,
    nextHop: hop.nextHop,
    distance: hop.distance,
    metric: hop.metric,
    why: hop.why,
    resolvedThrough: hop.via.map((v) => `${v.prefix} (${v.protocol})`),
    vrf: hop.vrf ?? null,
    segment: hop.segment ?? null,
    bgp: hop.bgp ?? null,
  }));
}

/**
 * The path in sentences, numbered.
 *
 * Every line is a restatement of something in the trace — no line is added
 * because a diagram of this kind usually has one.
 */
export function applicationNarrative(result: TraceResult, app: Application): string[] {
  const lines: string[] = [];
  const flow = flowLabel(app);
  const path = result.paths[0];

  if (!path || path.length === 0) {
    lines.push(
      result.kind === 'insufficient'
        ? `No path could be worked out for ${flow} to ${app.destination}.`
        : `Nothing could be traced for ${flow} to ${app.destination}.`,
    );
    if (result.kind === 'insufficient' || result.kind === 'unreachable') {
      lines.push(result.reason);
    }
    return lines;
  }

  lines.push(`${flow} to ${app.destination} enters at ${path[0]!.device}.`);
  for (const hop of path) {
    // Each kind of step is described as what it is. A NAT told as "forwards
    // to" and an L2 extension told as "next hop" are the two ways this sort of
    // narrative usually misleads.
    switch (hop.segment?.kind) {
      case 'nat':
        lines.push(
          `${hop.device} translates the destination from ${hop.segment.was} to ${hop.segment.now}` +
            `${hop.segment.description ? ` (${hop.segment.description})` : ''}. Everything after this is routed for ${hop.segment.now}.`,
        );
        continue;
      case 'vip':
        lines.push(
          `${hop.device} answers for the virtual address ${hop.segment.vip}` +
            `${hop.segment.description ? ` (${hop.segment.description})` : ''} and selects ${hop.segment.member} from the pool.`,
        );
        continue;
      case 'overlay':
        lines.push(
          `${hop.device} bridges the traffic into VNI ${hop.segment.vni}` +
            `${hop.segment.vlan ? `, which carries VLAN ${hop.segment.vlan}` : ''}, and tunnels it from VTEP ` +
            `${hop.segment.localVtep} to ${hop.segment.remoteVtep} on ${hop.segment.remote}. This is a layer 2 extension, not a routed hop.`,
        );
        continue;
      case 'underlay':
        lines.push(
          `  Underlay: ${hop.device} carries the tunnel towards ${hop.segment.remoteVtep}` +
            `${hop.nextHop ? ` via ${hop.nextHop}` : ''}${hop.outInterface ? ` out of ${hop.outInterface}` : ''}.`,
        );
        continue;
      case 'decapsulate':
        lines.push(
          `${hop.device} takes the traffic out of VNI ${hop.segment.vni} and delivers it on the local segment.`,
        );
        continue;
      case 'otv':
        lines.push(
          `${hop.device} carries the frame across OTV (${hop.segment.overlay}, VLAN ${hop.segment.vlan}) to ${hop.segment.remote}, ` +
            `which its OTV route table names as the edge owning ${hop.segment.mac}. This is a layer 2 extension between sites, not a routed hop.`,
        );
        continue;
      default:
        break;
    }
    if (hop.nextHop === null) {
      lines.push(
        `${hop.device} has ${hop.prefix} connected${hop.outInterface ? ` on ${hop.outInterface}` : ''}, so the destination is on a network it is attached to.`,
      );
      continue;
    }
    lines.push(
      `${hop.device} selects ${hop.prefix} by ${hop.protocol}` +
        `${hop.vrf ? ` in VRF ${hop.vrf}` : ''} and forwards to ${hop.nextHop}` +
        `${hop.outInterface ? ` out of ${hop.outInterface}` : ''}.` +
        (hop.bgp
          ? ` BGP chose it with${hop.bgp.localPreference != null ? ` local preference ${hop.bgp.localPreference}` : ''}` +
            `${hop.bgp.asPath ? `, AS path ${hop.bgp.asPath}` : ''}${hop.bgp.med != null ? `, MED ${hop.bgp.med}` : ''}.`
          : ''),
    );
    if (hop.via.length > 0) {
      lines.push(
        `  ${hop.nextHop} is not directly connected; it resolves through ${hop.via.map((v) => `${v.prefix} (${v.protocol})`).join(' then ')}.`,
      );
    }
  }

  if (result.kind === 'delivered') {
    lines.push(
      `The path ends at ${path[path.length - 1]!.device}, which is on the network holding ${finalTarget(path, app.destination)}.`,
    );
    if (result.paths.length > 1) {
      lines.push(`${result.paths.length} equal-cost paths were found; each is drawn.`);
    }
  }
  if (result.kind === 'unreachable') lines.push(`It goes no further: ${result.reason}`);
  if (result.kind === 'loop') lines.push(`The routes point in a circle at ${result.at}.`);
  return lines;
}

/**
 * The address the traffic is actually aimed at by the end of a path.
 *
 * A NAT and a load balancer both rewrite it, so the destination somebody typed
 * is not necessarily where the packet went. Drawing the original at the bottom
 * of the page would quietly contradict the NAT step just above it.
 */
export function finalTarget(path: readonly Hop[], asked: string): string {
  let target = asked.trim();
  for (const hop of path) {
    if (hop.segment?.kind === 'nat') target = hop.segment.now;
    if (hop.segment?.kind === 'vip') target = hop.segment.member;
  }
  return target;
}

/** What could not be worked out, so the diagram and the report can say so. */
export function unresolvedOf(result: TraceResult): string | null {
  if (result.kind === 'insufficient' || result.kind === 'unreachable') return result.reason;
  if (result.kind === 'loop') return `The routes form a loop at ${result.at}.`;
  return null;
}

function deviceNode(
  label: string,
  deviceType: DeviceType,
  position: { x: number; y: number },
  data: Partial<DeviceNodeData>,
): TopoNode {
  return {
    id: uid(),
    type: 'device',
    position,
    ...NODE,
    data: {
      label,
      deviceType,
      tags: ['application-path'],
      addresses: [],
      locked: false,
      maintenance: false,
      showDetails: true,
      ...data,
    } as DeviceNodeData,
  } as TopoNode;
}

function flowEdge(source: string, target: string, label: string, notes: string, dashed = false): TopoEdge {
  return {
    id: uid(),
    source,
    target,
    sourceHandle: 'b',
    targetHandle: 't',
    type: 'live',
    data: {
      label,
      sourcePortLabel: '',
      targetPortLabel: '',
      enabled: true,
      maintenance: false,
      notes,
      direction: 'forward',
      ...(dashed ? { lineStyle: 'dashed' } : {}),
      // A generated page is a drawing, not a monitored diagram: these links
      // stand for a forwarding decision, not a cable that can be up or down.
      healthRule: { type: 'always-ok' },
    } as unknown as LinkData,
  } as TopoEdge;
}

export interface GeneratedPage {
  nodes: TopoNode[];
  edges: TopoEdge[];
  /** One list per path, in the order they are drawn. */
  steps: AppStep[][];
  narrative: string[];
  unresolved: string | null;
}

/**
 * The application page: the flow, drawn.
 *
 * A column per path — one normally, several for ECMP — with the source above
 * and the destination below, so the drawing reads top to bottom the way the
 * traffic does. Every node and edge here is new; nothing is read from or
 * written to the page the trace was calculated against.
 */
/** LT-492: what the crawl knew about a device's addresses, by hostname. */
export type AddressesOf = (hostname: string) => readonly { ip: string; interface?: string | null; isManagement?: boolean }[];

/** A crawled device's addresses as a drawn device keeps them: management
 *  first and primary, so the generated box can be probed and logged into
 *  like the one it stands for; each address once. */
function addressesFor(addressesOf: AddressesOf | undefined, hostname: string): DeviceNodeData['addresses'] {
  const seen = new Set<string>();
  const found = [...(addressesOf?.(hostname) ?? [])]
    .filter((a) => a.ip?.trim() && !seen.has(a.ip.trim()) && seen.add(a.ip.trim()))
    .sort((a, b) => Number(!!b.isManagement) - Number(!!a.isManagement));
  return found.map((a, i) => ({
    id: uid(),
    label: a.isManagement ? 'Management' : a.interface?.trim() || 'Address',
    address: a.ip.trim(),
    isPrimary: i === 0,
  }));
}

export function buildApplicationPage(result: TraceResult, app: Application, addressesOf?: AddressesOf): GeneratedPage {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const flow = flowLabel(app);
  const paths = result.paths.length > 0 ? result.paths : [[]];

  // The source sits above everything, once, however many paths leave it.
  const source = deviceNode(app.source.trim() || 'Source', 'generic', { x: 0, y: 0 }, {
    notes: `Source of ${flow}${app.vrf?.trim() ? ` in VRF ${app.vrf.trim()}` : ''}.`,
    discoveredVia: 'Application path',
    // LT-492: a drawn device with no address can be neither probed nor
    // logged into; the crawl's own addresses come with it.
    addresses: addressesFor(addressesOf, app.source.trim()),
  });
  nodes.push(source);

  const width = (paths.length - 1) * COLUMN;
  paths.forEach((path, column) => {
    const x = paths.length === 1 ? 0 : column * COLUMN - width / 2;
    let previous = source.id;

    path.forEach((hop, row) => {
      const look = lookOf(hop);
      const node = deviceNode(
        // The kind of step is part of the label: an engineer reading the page
        // must be able to see at a glance that a box is a NAT or a VTEP and
        // not another routed hop.
        look.prefix ? `${hop.device} · ${look.prefix}` : hop.device,
        look.type,
        { x, y: (row + 1) * ROW },
        {
          hostname: hop.device,
          addresses: addressesFor(addressesOf, hop.device),
          notes: hop.why,
          vrf: hop.vrf ?? (app.vrf?.trim() || undefined),
          switchPort: hop.outInterface ?? undefined,
          discoveredVia: 'Application path',
          ...(hop.segment?.kind === 'overlay' && hop.segment.vlan
            ? { vlan: String(hop.segment.vlan) }
            : {}),
          tags: [
            'application-path',
            ...(hop.segment ? [hop.segment.kind] : []),
            ...(hop.segment?.kind === 'underlay' ? ['underlay'] : []),
          ],
        },
      );
      nodes.push(node);
      edges.push(flowEdge(previous, node.id, edgeLabel(hop, row === 0 ? flow : null), hop.why,
        // The tunnel and its underlay are drawn dashed: they are not a cable
        // between those two boxes, and a solid line would say they were.
        hop.segment?.kind === 'overlay' || hop.segment?.kind === 'underlay'));
      previous = node.id;

      // A next hop that needed the routing table to resolve gets its chain
      // shown beside the hop — it is the part of a BGP path that is otherwise
      // invisible.
      if (hop.via.length > 0) {
        const via = deviceNode(
          `via ${hop.nextHop}`,
          'generic',
          { x: x + COLUMN * 0.75, y: (row + 1) * ROW },
          {
            notes: `Resolved through ${hop.via.map((v) => `${v.prefix} (${v.protocol})`).join(' then ')}.`,
            discoveredVia: 'Application path',
          },
        );
        nodes.push(via);
        edges.push(flowEdge(node.id, via.id, 'resolves', via.data.notes as string, true));
      }
    });

    // Where it ends: the destination, or a marker saying why it does not.
    const trouble = unresolvedOf(result);
    const last = path.length;
    if (result.kind === 'delivered') {
      // What it is really aimed at by now, which a NAT or a VIP may have
      // changed. The original is kept in the note so both are on the page.
      const target = finalTarget(path, app.destination);
      const end = deviceNode(target, 'server', { x, y: (last + 1) * ROW }, {
        addresses: [{ id: uid(), label: 'Destination', address: target, isPrimary: true }],
        notes:
          target === app.destination.trim()
            ? `Destination of ${flow}.`
            : `Destination of ${flow}. Asked for as ${app.destination.trim()}; translated along the way.`,
        discoveredVia: 'Application path',
      });
      nodes.push(end);
      edges.push(flowEdge(previous, end.id, flow, `${flow} delivered to ${finalTarget(path, app.destination)}.`));
    } else if (trouble) {
      // Drawn, and drawn as a gap: a diagram that stops without saying why
      // reads as a diagram that is finished.
      const stop = deviceNode('Unresolved', 'generic', { x, y: (last + 1) * ROW }, {
        notes: trouble,
        discoveredVia: 'Application path',
        tags: ['application-path', 'unresolved'],
      });
      nodes.push(stop);
      edges.push(flowEdge(previous, stop.id, 'unresolved', trouble, true));
    }
  });

  return {
    nodes,
    edges,
    steps: result.paths.map(applicationSteps),
    narrative: applicationNarrative(result, app),
    unresolved: unresolvedOf(result),
  };
}

/**
 * The report, as Markdown.
 *
 * Application-centric and short: what it is, where it goes, what it passes
 * through and why — and a section naming what could not be worked out, which
 * is the part a reader needs most and is usually missing.
 */
export function applicationReport(result: TraceResult, app: Application, page: GeneratedPage): string {
  const out: string[] = [];
  const flow = flowLabel(app);
  out.push(`# ${applicationPageName(app)}`, '');
  out.push('| | |', '| --- | --- |');
  out.push(`| Application | ${app.name?.trim() || '—'} |`);
  out.push(`| Source | ${app.source.trim()} |`);
  out.push(`| Destination | ${app.destination.trim()} |`);
  out.push(`| Protocol and port | ${flow} |`);
  out.push(`| VRF | ${app.vrf?.trim() || 'default'} |`);
  out.push(`| Result | ${result.kind} |`);
  out.push('');

  page.steps.forEach((steps, i) => {
    if (page.steps.length > 1) out.push(`## Path ${i + 1} of ${page.steps.length} (equal cost)`, '');
    else out.push('## The path', '');
    out.push('| # | Device | Out of | Prefix | Protocol | Next hop | Dist/metric |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of steps) {
      out.push(
        `| ${s.order} | ${s.device} | ${s.interface ?? '—'} | ${s.prefix ?? '—'} | ${s.protocol ?? '—'} | ${s.nextHop ?? '—'} | ${s.distance ?? '—'}/${s.metric ?? '—'} |`,
      );
    }
    out.push('');
    const recursed = steps.filter((s) => s.resolvedThrough.length > 0);
    if (recursed.length > 0) {
      out.push('### Next hops resolved recursively', '');
      for (const s of recursed) out.push(`- **${s.device}** ${s.nextHop} → ${s.resolvedThrough.join(' → ')}`);
      out.push('');
    }
  });

  out.push('## Why this path', '');
  page.narrative.forEach((line, i) => out.push(`${i + 1}. ${line.trim()}`));
  out.push('');

  out.push('## Not resolved', '');
  out.push(
    page.unresolved ??
      'Every hop on this path was resolved from collected routing data.',
  );
  out.push('');
  out.push(
    '> Coreview reports what discovery collected. Routes are read from the global ' +
      'routing table; per-VRF tables, VXLAN/EVPN overlays and NAT or load-balancer ' +
      'translations are not collected, so a path that depends on them is reported as ' +
      'unresolved rather than guessed.',
  );
  return `${out.join('\n')}\n`;
}
