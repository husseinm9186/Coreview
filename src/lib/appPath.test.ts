import { describe, expect, it } from 'vitest';

import {
  applicationNarrative,
  applicationPageName,
  applicationReport,
  applicationSteps,
  buildApplicationPage,
  flowLabel,
  unresolvedOf,
  type Application,
} from './appPath';
import { tracePath, type PathDevice, type PathRoute } from './pathTrace';
import { withNewPage } from './pages';
import type { ProjectDocument } from '../state/store';
import type { DeviceNodeData } from '../types/domain';

const route = (over: Partial<PathRoute> & { prefix: string }): PathRoute => ({
  family: 4, protocol: 'static', nextHops: [], ...over,
});

/** Edge → firewall (NAT) → load balancer (VIP) → two web servers. */
const fw: PathDevice = {
  hostname: 'FW-01',
  addresses: [{ ip: '203.0.113.1' }],
  routes: [route({ prefix: '10.20.0.0/16', protocol: 'static', nextHops: ['10.20.0.2'], interface: 'Gi0/1' })],
  nat: [{ kind: 'destination', matches: '203.0.113.50', becomes: '10.20.0.50', port: 443, description: 'Customer Portal' }],
  neighbours: [{ localInterface: 'Gi0/1', name: 'LB-01' }],
};
const lb: PathDevice = {
  hostname: 'LB-01',
  addresses: [{ ip: '10.20.0.2' }],
  routes: [route({ prefix: '10.20.0.0/16', protocol: 'connected', interface: 'Vlan20' })],
  vips: [{ address: '10.20.0.50', port: 443, members: ['10.20.0.11'], description: 'Portal pool' }],
};
const web: PathDevice = { hostname: 'WEB-01', addresses: [{ ip: '10.20.0.11' }], routes: [] };

const portal: Application = {
  name: 'Customer Portal',
  source: 'FW-01',
  destination: '203.0.113.50',
  protocol: 'tcp',
  port: 443,
};

const traced = () => tracePath({ devices: [fw, lb, web], from: 'FW-01', to: '203.0.113.50', port: 443 });

describe('naming an application page (LT-348)', () => {
  it('says what it is without being opened', () => {
    expect(applicationPageName(portal)).toBe('APP - Customer Portal - TCP 443');
  });

  it('falls back to the endpoints when nobody named it', () => {
    expect(applicationPageName({ source: 'A', destination: '10.0.0.1', protocol: 'tcp', port: 22 }))
      .toBe('APP - A → 10.0.0.1 - TCP 22');
  });

  it('describes the flow in a word', () => {
    expect(flowLabel(portal)).toBe('TCP/443');
    expect(flowLabel({ source: 'a', destination: 'b', protocol: 'icmp' })).toBe('ICMP');
    expect(flowLabel({ source: 'a', destination: 'b' })).toBe('any');
  });
});

describe('the generated diagram is drawn, not listed', () => {
  const page = () => buildApplicationPage(traced(), portal);

  it('has a node for the source, every step, and the destination', () => {
    const p = page();
    const labels = p.nodes.map((n) => (n.data as DeviceNodeData).label);
    expect(labels[0]).toBe('FW-01');
    expect(p.nodes.length).toBeGreaterThan(3);
  });

  it('ends at the address the traffic is really aimed at, not the one typed', () => {
    // A NAT and a VIP both rewrote it. Drawing 203.0.113.50 at the bottom
    // would quietly contradict the NAT box two steps above.
    const p = page();
    const end = p.nodes[p.nodes.length - 1]!.data as DeviceNodeData;
    expect(end.label).toBe('10.20.0.11');
    // And the original is still on the page, so both are visible.
    expect(end.notes).toMatch(/Asked for as 203\.0\.113\.50/);
  });

  it('joins every node with a line, so the path is a path', () => {
    const p = page();
    // A connected graph: as many links as nodes less one, at minimum.
    expect(p.edges.length).toBeGreaterThanOrEqual(p.nodes.length - 1);
    const ids = new Set(p.nodes.map((n) => n.id));
    for (const e of p.edges) {
      expect(ids.has(e.source), `source ${e.source}`).toBe(true);
      expect(ids.has(e.target), `target ${e.target}`).toBe(true);
    }
  });

  it('labels a NAT and a VIP as what they are, not as another routed hop', () => {
    const p = page();
    const labels = p.nodes.map((n) => (n.data as DeviceNodeData).label);
    expect(labels.some((l) => l.includes('FW-01 · NAT'))).toBe(true);
    expect(labels.some((l) => l.includes('LB-01 · VIP'))).toBe(true);
    // And they get the right glyph.
    const nat = p.nodes.find((n) => (n.data as DeviceNodeData).label.includes('NAT'))!;
    expect((nat.data as DeviceNodeData).deviceType).toBe('firewall');
    const vip = p.nodes.find((n) => (n.data as DeviceNodeData).label.includes('VIP'))!;
    expect((vip.data as DeviceNodeData).deviceType).toBe('load-balancer');
  });

  it('tags every generated object, so the page can be told from a drawn one', () => {
    for (const n of page().nodes) {
      expect((n.data as DeviceNodeData).tags).toContain('application-path');
    }
  });

  it('draws one column per equal-cost path rather than hiding the alternates', () => {
    const two: PathDevice = {
      ...lb,
      vips: [{ address: '10.20.0.50', port: 443, members: ['10.20.0.11', '10.20.0.12'] }],
    };
    const web2: PathDevice = { hostname: 'WEB-02', addresses: [{ ip: '10.20.0.12' }], routes: [] };
    const out = tracePath({ devices: [fw, two, web, web2], from: 'FW-01', to: '203.0.113.50', port: 443 });
    const p = buildApplicationPage(out, portal);
    expect(p.steps).toHaveLength(2);
    const xs = new Set(p.nodes.map((n) => n.position.x));
    expect(xs.size).toBeGreaterThan(1);
  });
});

describe('the ordered list and the explanation', () => {
  it('numbers every device with its interface, prefix, protocol and next hop', () => {
    const steps = applicationSteps(traced().paths[0]!);
    expect(steps[0]!.order).toBe(1);
    expect(steps.map((s) => s.device)).toContain('LB-01');
    const routed = steps.find((s) => s.protocol === 'static')!;
    expect(routed.prefix).toBe('10.20.0.0/16');
    expect(routed.interface).toBe('Gi0/1');
  });

  it('carries the NAT and the VIP through as structured facts', () => {
    const steps = applicationSteps(traced().paths[0]!);
    expect(steps.find((s) => s.segment?.kind === 'nat')?.segment).toMatchObject({ now: '10.20.0.50' });
    expect(steps.find((s) => s.segment?.kind === 'vip')?.segment).toMatchObject({ member: '10.20.0.11' });
  });

  it('explains the path in sentences, every one of them a fact from the trace', () => {
    const lines = applicationNarrative(traced(), portal);
    expect(lines[0]).toMatch(/TCP\/443 to 203\.0\.113\.50 enters at FW-01/);
    expect(lines.join(' ')).toMatch(/translates the destination from 203\.0\.113\.50 to 10\.20\.0\.50/);
    expect(lines.join(' ')).toMatch(/answers for the virtual address 10\.20\.0\.50/);
    expect(lines.join(' ')).toMatch(/selects 10\.20\.0\.11 from the pool/);
  });

  it('says plainly when there is nothing to explain', () => {
    const none = tracePath({ devices: [], from: 'GHOST', to: '10.0.0.1' });
    expect(applicationNarrative(none, portal).join(' ')).toMatch(/No path could be worked out/);
    expect(unresolvedOf(none)).toMatch(/not a device this project has crawled/);
  });
});

describe('the export', () => {
  const report = () => {
    const out = traced();
    return applicationReport(out, portal, buildApplicationPage(out, portal));
  };

  it('is application-centric, not a dump of the network', () => {
    const md = report();
    expect(md).toMatch(/^# APP - Customer Portal - TCP 443/);
    expect(md).toContain('| Application | Customer Portal |');
    expect(md).toContain('| Protocol and port | TCP/443 |');
    expect(md).toContain('| VRF | default |');
  });

  it('has the ordered device table', () => {
    const md = report();
    expect(md).toContain('| # | Device | Out of | Prefix | Protocol | Next hop | Dist/metric |');
    expect(md).toContain('FW-01');
    expect(md).toContain('LB-01');
  });

  it('always has a section saying what was not resolved', () => {
    expect(report()).toContain('## Not resolved');
    // And when everything did resolve, it says so rather than leaving a blank.
    expect(report()).toMatch(/Every hop on this path was resolved|could not/);
  });

  it('names what discovery does not collect, so the reader is not misled', () => {
    expect(report()).toMatch(/per-VRF tables, VXLAN\/EVPN overlays and NAT or load-balancer/);
  });
});

describe('the source topology is never touched (non-negotiable)', () => {
  const original: ProjectDocument = {
    activePageId: 'p1',
    probes: [],
    pages: [
      {
        id: 'p1',
        name: 'Network',
        canvas: { gridEnabled: true, snapEnabled: true, minimap: true, nodeStyle: 'glyph' },
        nodes: [{ id: 'n1', type: 'device', position: { x: 10, y: 20 }, data: { label: 'CORE', deviceType: 'router', tags: [] } }],
        edges: [],
      },
    ],
  } as unknown as ProjectDocument;

  it('generates a page without reading or writing the existing one', () => {
    const before = JSON.stringify(original);
    const p = buildApplicationPage(traced(), portal);
    const after = withNewPage(original, applicationPageName(portal), 'p2', { nodes: p.nodes, edges: p.edges });

    // The source document object is untouched…
    expect(JSON.stringify(original)).toBe(before);
    // …and so is its page inside the new document.
    expect(JSON.stringify(after.pages[0])).toBe(JSON.stringify(original.pages[0]));
    expect(after.pages[0]!.nodes[0]!.position).toEqual({ x: 10, y: 20 });
  });

  it('puts the generated diagram on a page of its own and makes it active', () => {
    const p = buildApplicationPage(traced(), portal);
    const after = withNewPage(original, applicationPageName(portal), 'p2', { nodes: p.nodes, edges: p.edges });
    expect(after.pages).toHaveLength(2);
    expect(after.activePageId).toBe('p2');
    expect(after.pages[1]!.name).toBe('APP - Customer Portal - TCP 443');
    expect(after.pages[1]!.nodes.length).toBe(p.nodes.length);
  });

  it('shares no node or link id with the original, so nothing can collide', () => {
    const p = buildApplicationPage(traced(), portal);
    const theirs = new Set(original.pages[0]!.nodes.map((n) => n.id));
    for (const n of p.nodes) expect(theirs.has(n.id)).toBe(false);
  });

  it('makes a second independent page for a second application', () => {
    const p1 = buildApplicationPage(traced(), portal);
    const one = withNewPage(original, applicationPageName(portal), 'p2', { nodes: p1.nodes, edges: p1.edges });
    const other: Application = { ...portal, name: 'Reporting', port: 8443 };
    const p2 = buildApplicationPage(traced(), other);
    const two = withNewPage(one, applicationPageName(other), 'p3', { nodes: p2.nodes, edges: p2.edges });

    expect(two.pages).toHaveLength(3);
    expect(two.pages.map((x) => x.name)).toEqual([
      'Network', 'APP - Customer Portal - TCP 443', 'APP - Reporting - TCP 8443',
    ]);
    // Generating the second did not touch the first.
    expect(JSON.stringify(two.pages[1])).toBe(JSON.stringify(one.pages[1]));
  });

  it('gives two generations of the same application separate pages, not one overwritten', () => {
    const p = buildApplicationPage(traced(), portal);
    const one = withNewPage(original, applicationPageName(portal), 'p2', { nodes: p.nodes, edges: p.edges });
    const two = withNewPage(one, applicationPageName(portal), 'p3', { nodes: p.nodes, edges: p.edges });
    expect(two.pages).toHaveLength(3);
    // The name is made unique rather than clobbering the first.
    expect(two.pages[2]!.name).toBe('APP - Customer Portal - TCP 443 2');
  });
});

describe('failure simulation reaches the generated page', () => {
  it('draws the alternate path after a device is taken out', () => {
    const a: PathDevice = {
      hostname: 'A',
      addresses: [{ ip: '10.0.0.1' }],
      routes: [
        route({ prefix: '10.9.0.0/16', protocol: 'ospf', nextHops: ['10.0.1.2'], distance: 110, metric: 2 }),
        route({ prefix: '10.9.0.0/16', protocol: 'ospf', nextHops: ['10.0.2.2'], distance: 110, metric: 9 }),
        route({ prefix: '10.0.1.0/30', protocol: 'connected', interface: 'Gi0/1' }),
        route({ prefix: '10.0.2.0/30', protocol: 'connected', interface: 'Gi0/2' }),
      ],
    };
    const left: PathDevice = { hostname: 'LEFT', addresses: [{ ip: '10.0.1.2' }], routes: [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Vlan9' })] };
    const right: PathDevice = { hostname: 'RIGHT', addresses: [{ ip: '10.0.2.2' }], routes: [route({ prefix: '10.9.0.0/16', protocol: 'connected', interface: 'Vlan9' })] };
    const app: Application = { source: 'A', destination: '10.9.0.9', protocol: 'tcp', port: 443 };

    const before = buildApplicationPage(tracePath({ devices: [a, left, right], from: 'A', to: '10.9.0.9' }), app);
    expect(before.steps[0]!.map((s) => s.device)).toContain('LEFT');

    const after = buildApplicationPage(
      tracePath({ devices: [a, left, right], from: 'A', to: '10.9.0.9', without: { devices: ['LEFT'] } }),
      app,
    );
    expect(after.steps[0]!.map((s) => s.device)).toContain('RIGHT');
    expect(after.nodes.some((n) => (n.data as DeviceNodeData).label.includes('RIGHT'))).toBe(true);
  });

  it('draws an unresolved marker rather than stopping in silence', () => {
    const only: PathDevice = { hostname: 'R1', addresses: [{ ip: '10.0.0.1' }], routes: [] };
    const app: Application = { source: 'R1', destination: '198.51.100.7' };
    const page = buildApplicationPage(tracePath({ devices: [only], from: 'R1', to: '198.51.100.7' }), app);
    expect(page.unresolved).toMatch(/no route to 198\.51\.100\.7/);
    const stop = page.nodes.find((n) => (n.data as DeviceNodeData).label === 'Unresolved');
    expect(stop, 'an unresolved marker should be drawn').toBeTruthy();
    expect((stop!.data as DeviceNodeData).tags).toContain('unresolved');
  });
});
