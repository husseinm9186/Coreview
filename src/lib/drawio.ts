/**
 * The diagram as a draw.io file (LT-250).
 *
 * draw.io is free and runs in a browser, so it is what a colleague without
 * Coreview or Visio most likely has. The file is written uncompressed — the
 * format draw.io itself saves by default today — with one `<diagram>` per
 * page, devices as the network stencils draw.io ships (`mxgraph.networks.*`,
 * names taken from its own `networks.xml`), links glued to both ends with
 * their bends kept, and ports written the way the draw.io and Visio readers
 * both split them back out: `Gi0/1 <> Gi0/2`.
 */
import type { TopoEdge, TopoNode } from '../state/store';
import type { DeviceNodeData, DeviceType, LinkData, NoteNodeData } from '../types/domain';
import { noteBlocks, plainLine } from './noteMarkdown';

export interface DrawioPage {
  name: string;
  nodes: TopoNode[];
  edges: TopoEdge[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** Stencils in draw.io's `networks.xml`, as its shape names. */
const STENCIL: Partial<Record<DeviceType, string>> = {
  firewall: 'firewall',
  waf: 'firewall',
  router: 'router',
  'core-switch': 'switch',
  'distribution-switch': 'switch',
  'access-switch': 'switch',
  'l3-switch': 'switch',
  'l2-switch': 'switch',
  'wireless-controller': 'wireless_hub',
  'access-point': 'wireless_hub',
  'ip-phone': 'phone_1',
  'blade-chassis': 'server',
  'load-balancer': 'load_balancer',
  server: 'server',
  vm: 'virtual_server',
  'vm-host': 'server',
  storage: 'storage',
  endpoint: 'pc',
  printer: 'printer',
  camera: 'security_camera',
  internet: 'cloud',
  'private-cloud': 'cloud',
  'mpls-cloud': 'cloud',
  rack: 'rack',
  'patch-panel': 'patch_panel',
  ups: 'ups_enterprise',
  application: 'web_server',
  database: 'storage',
};

/** Drawing shapes, as draw.io's own built-in shape styles. */
const BASIC: Partial<Record<DeviceType, string>> = {
  rectangle: 'rounded=0;whiteSpace=wrap;html=1;',
  rounded: 'rounded=1;whiteSpace=wrap;html=1;',
  circle: 'ellipse;whiteSpace=wrap;html=1;',
  diamond: 'rhombus;whiteSpace=wrap;html=1;',
  cloud: 'ellipse;shape=cloud;whiteSpace=wrap;html=1;',
  zone: 'rounded=0;whiteSpace=wrap;html=1;fillColor=none;dashed=1;verticalAlign=top;align=left;spacingLeft=8;',
  text: 'text;html=1;strokeColor=none;fillColor=none;whiteSpace=wrap;',
  callout: 'shape=callout;whiteSpace=wrap;html=1;perimeter=calloutPerimeter;',
  site: 'rounded=1;whiteSpace=wrap;html=1;dashed=1;verticalAlign=top;',
  vpn: 'rounded=1;whiteSpace=wrap;html=1;dashed=1;',
};

const STENCIL_STYLE = 'verticalLabelPosition=bottom;verticalAlign=top;labelPosition=center;align=center;html=1;outlineConnect=0;fillColor=#CCCCCC;strokeColor=#6881B3;gradientColor=none;strokeWidth=2;aspect=fixed;';

function styleFor(d: DeviceNodeData): string {
  const basic = BASIC[d.deviceType];
  if (basic) return basic;
  const stencil = STENCIL[d.deviceType];
  const label = d.labelStyle;
  const font = [
    label?.bold || label?.italic ? `fontStyle=${(label.bold ? 1 : 0) + (label.italic ? 2 : 0)};` : '',
    label?.size ? `fontSize=${Math.round(label.size)};` : '',
    label?.color && /^#[0-9a-f]{3,8}$/i.test(label.color) ? `fontColor=${label.color};` : '',
  ].join('');
  return stencil ? `${STENCIL_STYLE}shape=mxgraph.networks.${stencil};${font}` : `rounded=1;whiteSpace=wrap;html=1;${font}`;
}

function pageModel(page: DrawioPage, used: Set<string>): string {
  // Ids are unique across the whole file, as draw.io expects.
  const idFor = new Map<string, string>();
  const id = (raw: string) => {
    let v = idFor.get(raw);
    if (!v) {
      v = raw.replace(/[^A-Za-z0-9_-]/g, '_') || 'cell';
      while (used.has(v)) v = `${v}_`;
      used.add(v);
      idFor.set(raw, v);
    }
    return v;
  };
  const root = id(`${page.name}-root`);
  const layer = id(`${page.name}-layer`);
  const cells: string[] = [`<mxCell id="${root}"/>`, `<mxCell id="${layer}" parent="${root}"/>`];
  const nodes = new Set<string>();
  for (const n of page.nodes) {
    const w = Math.round(n.width ?? n.measured?.width ?? 76);
    const h = Math.round(n.height ?? n.measured?.height ?? 76);
    const geometry = `<mxGeometry x="${Math.round(n.position.x)}" y="${Math.round(n.position.y)}" width="${w}" height="${h}" as="geometry"/>`;
    if (n.type === 'note') {
      const d = n.data as NoteNodeData;
      const text = [d.title, ...noteBlocks(d.body ?? '').map((b) => plainLine(b).text)].filter(Boolean).join('\n');
      const style = d.variant === 'sticky' ? 'shape=note;whiteSpace=wrap;html=0;align=left;verticalAlign=top;spacing=8;fillColor=#fff2cc;strokeColor=#d6b656;' : 'text;html=0;whiteSpace=wrap;align=left;verticalAlign=top;';
      cells.push(`<mxCell id="${id(n.id)}" value="${esc(text)}" style="${style}" parent="${layer}" vertex="1">${geometry}</mxCell>`);
      nodes.add(n.id);
      continue;
    }
    if (n.type !== 'device') continue;
    const d = n.data as DeviceNodeData;
    const address = d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address;
    // The address under the name, as the Visio and draw.io readers find it.
    const value = [d.label, address].filter(Boolean).join('\n');
    cells.push(`<mxCell id="${id(n.id)}" value="${esc(value)}" style="${styleFor(d).replace('html=1;', 'html=0;')}" parent="${layer}" vertex="1">${geometry}</mxCell>`);
    nodes.add(n.id);
  }
  for (const e of page.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
    const d = (e.data ?? {}) as Partial<LinkData>;
    const ports = d.sourcePortLabel && d.targetPortLabel ? `${d.sourcePortLabel} <> ${d.targetPortLabel}` : '';
    const value = ports || d.label || '';
    const colour = d.colorMode === 'fixed' && d.color && /^#[0-9a-f]{3,8}$/i.test(d.color) ? `strokeColor=${d.color};` : '';
    const dashed = d.lineStyle && d.lineStyle !== 'solid' && d.lineStyle !== 'auto' ? 'dashed=1;' : '';
    const points = (d.waypoints ?? []).map((p) => `<mxPoint x="${Math.round(p.x)}" y="${Math.round(p.y)}"/>`).join('');
    const style = `endArrow=none;html=0;${d.waypoints?.length ? 'edgeStyle=none;' : ''}${colour}${dashed}`;
    cells.push(
      `<mxCell id="${id(e.id)}" value="${esc(value)}" style="${style}" parent="${layer}" source="${id(e.source)}" target="${id(e.target)}" edge="1">` +
        `<mxGeometry relative="1" as="geometry">${points ? `<Array as="points">${points}</Array>` : ''}</mxGeometry></mxCell>`,
    );
  }
  return `<mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel>`;
}

/** Every page given, as one `.drawio` file. */
export function drawioFile(pages: DrawioPage[], modified = new Date()): string {
  const used = new Set<string>();
  const diagrams = pages.map((p, i) => `<diagram id="page-${i + 1}" name="${esc(p.name || `Page-${i + 1}`)}">${pageModel(p, used)}</diagram>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="Coreview" modified="${modified.toISOString()}" type="device" pages="${pages.length}">${diagrams.join('')}</mxfile>\n`;
}
