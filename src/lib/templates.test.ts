import { describe, expect, it } from 'vitest';

import { boundaryIdProblem } from './boundaries';
import { elevation, rackableOf, type Rackable } from './rack';
import type { DeviceNodeData } from '../types/domain';
import { TEMPLATES } from './templates';

/** RFC 5737 IPv4 documentation ranges. */
const DOC_V4 = [/^192\.0\.2\.\d+$/, /^198\.51\.100\.\d+$/, /^203\.0\.113\.\d+$/];
const docV4 = (a: string) => DOC_V4.some((r) => r.test(a.split('/')[0]!));
/** RFC 3849. */
const docV6 = (a: string) => /^2001:db8(:|$)/i.test(a.split('/')[0]!);

describe('templates (LT-187)', () => {
  it('has the nine the mission asks for', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'blank', 'branch-office', 'spine-leaf', 'campus', 'dmz', 'sd-wan', 'mpls-l3vpn', 'wireless-survey', 'rack-elevation',
    ]);
  });

  for (const t of TEMPLATES) {
    describe(t.name, () => {
      const doc = t.build();
      const json = JSON.stringify(doc);

      it('uses documentation addresses only', () => {
        const v4 = json.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
        for (const a of v4) expect(docV4(a), a).toBe(true);
        const v6 = json.match(/\b[0-9a-f]{1,4}:[0-9a-f:]*:[0-9a-f:]*\b/gi) ?? [];
        for (const a of v6) expect(docV6(a), a).toBe(true);
      });

      it('uses documentation AS numbers only', () => {
        for (const m of json.matchAll(/\bAS (\d+)\b/g)) {
          const asn = Number(m[1]);
          expect(asn >= 64496 && asn <= 64511, m[0]).toBe(true);
        }
        for (const n of doc.pages[0]!.nodes) {
          const d = n.data as { boundaryKind?: string; boundaryId?: string };
          if (d.boundaryKind === 'bgp-as') expect(Number(d.boundaryId) >= 64496 && Number(d.boundaryId) <= 64511).toBe(true);
        }
      });

      it('monitors nothing until told to', () => {
        expect(doc.probes).toEqual([]);
      });

      it('joins every link to devices that are there, with fresh ids', () => {
        const page = doc.pages[0]!;
        const ids = new Set(page.nodes.map((n) => n.id));
        for (const e of page.edges) {
          expect(ids.has(e.source)).toBe(true);
          expect(ids.has(e.target)).toBe(true);
        }
        expect(new Set([...page.nodes, ...page.edges].map((o) => o.id)).size).toBe(page.nodes.length + page.edges.length);
        expect(t.build().pages[0]!.id).not.toBe(page.id);
      });

      it('stands no device on another, and every section is a valid boundary', () => {
        const page = doc.pages[0]!;
        const devices = page.nodes.filter((n) => !['zone', 'text', 'callout'].includes((n.data as { deviceType: string }).deviceType));
        for (let i = 0; i < devices.length; i++) {
          for (let j = i + 1; j < devices.length; j++) {
            const a = devices[i]!;
            const b = devices[j]!;
            const apart = Math.abs(a.position.x - b.position.x) >= 76 + 40 || Math.abs(a.position.y - b.position.y) >= 76 + 40;
            expect(apart, `${(a.data as { label: string }).label} / ${(b.data as { label: string }).label}`).toBe(true);
          }
        }
        for (const n of page.nodes) {
          const d = n.data as { boundaryKind?: 'vlan'; boundaryId?: string };
          if (d.boundaryKind) expect(boundaryIdProblem(d.boundaryKind, d.boundaryId ?? ''), d.boundaryId).toBeNull();
        }
      });

      it('places every racked device inside its rack, clear of every other', () => {
        const devices: Rackable[] = doc.pages[0]!.nodes
          .filter((n) => n.type === 'device')
          .map((n) => rackableOf(n.id, n.data as DeviceNodeData));
        for (const rack of doc.racks ?? []) {
          for (const face of ['front', 'rear'] as const) {
            const e = elevation(rack, devices, face);
            expect(e.items.filter((i) => i.clash).map((i) => i.device.label)).toEqual([]);
            expect(e.unplaced.map((d) => d.label)).toEqual([]);
          }
        }
        const racked = devices.filter((d) => d.rack);
        for (const d of racked) expect((doc.racks ?? []).some((r) => r.name === d.rack), d.label).toBe(true);
      });

      it('starts with the standard views', () => {
        expect(doc.pages[0]!.canvas.layers?.map((l) => l.name)).toEqual(['Physical', 'Logical', 'Overlay', 'Annotations']);
      });
    });
  }
});
