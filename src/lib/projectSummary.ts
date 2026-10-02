/**
 * What a project card says about a project without opening it (LT-679):
 * how many devices and pages it has and how its checks stood, as of the
 * last time it was saved on this machine. Kept beside the other view
 * preferences in localStorage — never in the project, which is what travels
 * — so an older project, or one saved elsewhere, simply has no line yet.
 */
import type { HealthStatus } from '../types/domain';

export type ProjectSummary = {
  devices: number;
  links: number;
  pages: number;
  healthy: number;
  warning: number;
  down: number;
  unknown: number;
  /** When it was taken, ms since the epoch. */
  at: number;
};

const KEY = (id: string) => `coreview.summary.${id}`;

type Page = { nodes: { id: string; type?: string }[]; edges: unknown[] };

/** Counts a document's pages, devices and links, and each device's status. */
export function summarise(
  doc: { pages?: Page[]; nodes?: Page['nodes']; edges?: unknown[] },
  statusOf: (nodeId: string) => HealthStatus,
  at = Date.now(),
): ProjectSummary {
  const pages: Page[] = doc.pages ?? [{ nodes: doc.nodes ?? [], edges: doc.edges ?? [] }];
  const out: ProjectSummary = { devices: 0, links: 0, pages: pages.length, healthy: 0, warning: 0, down: 0, unknown: 0, at };
  for (const page of pages) {
    out.links += page.edges.length;
    for (const n of page.nodes) {
      if (n.type !== 'device') continue;
      out.devices += 1;
      const s = statusOf(n.id);
      if (s === 'healthy' || s === 'warning' || s === 'down') out[s] += 1;
      else out.unknown += 1;
    }
  }
  return out;
}

export function rememberSummary(id: string, summary: ProjectSummary): void {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(summary));
  } catch {
    /* private mode, or storage disabled — the card shows no line */
  }
}

export function readSummary(id: string): ProjectSummary | null {
  try {
    const raw = localStorage.getItem(KEY(id));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<ProjectSummary>;
    if (typeof s.devices !== 'number' || typeof s.at !== 'number') return null;
    return {
      devices: s.devices, links: s.links ?? 0, pages: s.pages ?? 1,
      healthy: s.healthy ?? 0, warning: s.warning ?? 0, down: s.down ?? 0, unknown: s.unknown ?? 0, at: s.at,
    };
  } catch {
    return null;
  }
}

export function forgetSummary(id: string): void {
  try {
    localStorage.removeItem(KEY(id));
  } catch {
    /* nothing to forget */
  }
}
