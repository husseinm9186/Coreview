/**
 * The chips over folded fans and folded sites, and the breadcrumb that says
 * where in the estate the view is.
 *
 * A chip is drawn in screen space — 22 px however far out the diagram is —
 * because it exists for the far view, where the fan it stands for would be
 * dust. It sits under the device holding the fan and says what is inside
 * and the worst of it: "12 access · 2 down". Clicking it opens the fan and
 * brings the view to it; the breadcrumb then names the way back.
 */
import { useViewport } from '@xyflow/react';

import { t } from '../i18n';
import { chipSummary } from '../lib/clusters';
import { useDragOverlay } from '../state/dragOverlay';
import { useStore, type TopoNode } from '../state/store';
import type { HealthStatus } from '../types/domain';

export interface ChipSpec {
  /** The holder's node id, or a folded site's stand-in id. */
  id: string;
  kind: 'branch' | 'site';
  /** The node the chip sits under, as drawn. */
  node: TopoNode;
  /** The devices folded away behind it. */
  held: TopoNode[];
  /** A folded site's name. */
  label?: string;
}

export function ClusterChips({ chips, onOpen }: { chips: ChipSpec[]; onOpen: (chip: ChipSpec) => void }) {
  const { x: vx, y: vy, zoom } = useViewport();
  // A chip's health is its devices' health, which the runtime changes.
  useStore((s) => s.runtime);
  useStore((s) => s.session.state);
  const moved = useDragOverlay((s) => s.moved);
  const statusOf = (id: string): HealthStatus => useStore.getState().nodeStatus(id);
  return (
    <div className="cv-cluster-chips" data-region="cluster-chips">
      {chips.map((c) => {
        const n = moved?.get(c.node.id) ?? c.node;
        const w = n.width ?? n.measured?.width ?? 76;
        const h = n.height ?? n.measured?.height ?? 76;
        const left = (n.position.x + w / 2) * zoom + vx;
        const top = (n.position.y + h) * zoom + vy + 6;
        const sum = chipSummary(c.held, statusOf);
        const text = c.kind === 'site' && c.label ? `${c.label} · ${sum.text}` : sum.text;
        return (
          <button
            key={c.id}
            type="button"
            className={`cv-cluster-chip is-${sum.worst}`}
            style={{ left, top }}
            data-region="cluster-chip"
            data-id={c.id}
            data-worst={sum.worst}
            title={t('cluster.openHint')}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(c);
            }}
          >
            <span className="cv-cluster-dot" aria-hidden="true" />
            {text}
          </button>
        );
      })}
    </div>
  );
}

export interface Crumb {
  id: string;
  label: string;
}

/**
 * "Diagram › Branch 2 › dist-2": the root, then each chip opened on the
 * way in. Each crumb goes back to its level, folding what was opened after
 * it; after the trail, how much is folded and a way to open all of it.
 */
export function CanvasCrumbs({
  trail,
  fans,
  sites,
  hidden,
  onBack,
  onExpandAll,
}: {
  trail: Crumb[];
  fans: number;
  sites: number;
  hidden: number;
  onBack: (index: number) => void;
  onExpandAll: () => void;
}) {
  const summary = [
    fans > 0 ? t('plural.fanFolded', { count: fans }) : '',
    sites > 0 ? t('plural.siteFolded', { count: sites }) : '',
    hidden > 0 ? t('cluster.hidden', { devices: t('plural.device', { count: hidden }) }) : '',
  ].filter(Boolean);
  return (
    <nav className="cv-canvas-crumbs" aria-label={t('cluster.crumbs')} data-region="canvas-crumbs">
      <button type="button" className={trail.length === 0 ? 'is-current' : ''} onClick={() => onBack(-1)}>
        {t('cluster.crumbRoot')}
      </button>
      {trail.map((c, i) => (
        <span key={c.id} className="cv-crumb">
          <span className="cv-crumb-sep" aria-hidden="true">›</span>
          <button type="button" className={i === trail.length - 1 ? 'is-current' : ''} onClick={() => onBack(i)}>
            {c.label}
          </button>
        </span>
      ))}
      {summary.length > 0 && <span className="cv-crumb-summary">{summary.join(' · ')}</span>}
      {(fans > 0 || sites > 0) && (
        <button type="button" className="cv-link-btn" data-region="expand-all" onClick={onExpandAll}>
          {t('cluster.expandAll')}
        </button>
      )}
    </nav>
  );
}
