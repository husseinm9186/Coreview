import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';

import { DeviceGlyph } from '../icons';
import { drawsStacked } from '../../lib/stacked';
import { cssOf } from '../../lib/textStyle';
import { BOUNDARIES, boundaryChip, boundaryIdProblem, isBoundaryKind } from '../../lib/boundaries';
import { canvasPalette, deviceColor, statusColors } from '../../theme';
import { colourForKey, keyForData } from '../../lib/tinting';
import { useStore } from '../../state/store';
import { openThreads } from '../../lib/comments';
import { timeAgo } from '../../lib/timeAgo';
import { ipc } from '../../lib/ipc';
import { activePage } from '../../lib/pages';
import type { DeviceNodeData, HealthStatus, ProbeRuntime } from '../../types/domain';
import { SHAPE_DEVICE_TYPES, STATUS_GLYPH, STATUS_LABEL } from '../../types/domain';

/** The monitored-objects table, brought to the cursor. While validation is
 *  running, the row for this device's primary probe — last result, round-trip
 *  time, when it was checked — floats over the node on hover, so reading a
 *  device's health does not mean finding it again in the panel. Ticks once a
 *  second so "4s ago" does not silently go stale under a held cursor. */
function LiveCard({ label, status, ink, live }: {
  label: string;
  status: HealthStatus;
  ink: string;
  live: ProbeRuntime;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const checked = Math.max(live.lastSuccessMs ?? 0, live.lastFailureMs ?? 0);
  const rtt =
    live.lastRttMs == null ? '—' : live.lastRttMs < 1 ? '<1 ms' : `${live.lastRttMs.toFixed(0)} ms`;
  return (
    <div className="cv-livecard nodrag nopan" role="tooltip">
      <div className="cv-livecard-head">
        <span className="cv-livecard-name">{label}</span>
        <span style={{ color: ink }}>{STATUS_LABEL[status]}</span>
      </div>
      <dl>
        <dt>Last result</dt>
        <dd>{live.lastSummary ?? '—'}</dd>
        <dt>RTT</dt>
        <dd>{rtt}</dd>
        <dt>Checked</dt>
        <dd>{checked ? timeAgo(checked) : 'not yet'}</dd>
      </dl>
    </div>
  );
}



/** Shapes a border and a border-radius cannot draw.
 *
 *  A rectangle, a rounded rectangle, a circle and a diamond are all a box with
 *  the right corners. A cloud is not, and it was quietly falling through to a
 *  plain rectangle — the shape was in the palette and drew a box on the
 *  canvas. These get a stretched outline drawn behind them instead. */
const OUTLINES: Partial<Record<string, string>> = {
  // Drawn in a 200x100 box and stretched to whatever the node is, so a wide
  // cloud looks like a wide cloud rather than a small one in a big box.
  cloud:
    'M46,88 C22,88 8,74 10,58 C12,44 26,36 38,39 C43,17 63,6 84,11 ' +
    'C99,15 109,26 112,39 C126,29 148,32 157,47 C176,46 192,58 189,73 ' +
    'C187,84 174,88 160,88 Z',
};

/**
 * A node label that can be typed on directly.
 *
 * Renaming a device meant selecting it, finding the field in the inspector and
 * typing there — three places for one word. Double-click puts the caret on the
 * label where it is drawn, which is where the eye already is.
 *
 * `nodrag` and `nopan` keep React Flow from treating the caret and the text
 * selection as the start of a drag.
 */
function EditableLabel({
  value,
  className,
  style,
  multiline = false,
  onCommit,
  startEditing = false,
  onStarted,
}: {
  value: string;
  className: string;
  /** LT-181: the label's own bold, italic, size, colour, background, alignment. */
  style?: React.CSSProperties;
  /** LT-182: text that keeps its line breaks — a text box or callout. Edited in
   *  a box where Enter finishes and Shift+Enter starts a new line. */
  multiline?: boolean;
  onCommit: (next: string) => void;
  /** Straight into typing, for text that has just been put on the canvas.
   *  Making someone double-click the thing they just created to type in it is
   *  a step that exists for no reason. */
  startEditing?: boolean;
  onStarted?: () => void;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!startEditing) return;
    setDraft(value);
    setEditing(true);
    onStarted?.();
    // Deliberately not depending on the value: this fires when the node is
    // created, and re-running it whenever the label changes would drag the
    // cursor back into a field somebody had left.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEditing]);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    // An empty name would leave an unidentifiable shape on the diagram.
    if (next && next !== value) onCommit(next);
    else setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        className={className}
        style={multiline ? { whiteSpace: 'pre-wrap', ...style } : style}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(value);
          setEditing(true);
        }}
        title="Double-click to rename"
      >
        {value}
      </div>
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={input}
        className={`${className} cv-inline-edit cv-inline-edit-multi nodrag nopan`}
        style={style}
        rows={Math.max(2, draft.split('\n').length)}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <input
      ref={input}
      className={`${className} cv-inline-edit nodrag nopan`}
      style={style}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

function DeviceNodeInner({ id, data, selected }: NodeProps) {
  const d = data as DeviceNodeData;
  const status = useStore((s) => s.nodeStatus(id));
  // s.doc.probes is a stable reference; filtering *inside* the selector would
  // return a fresh array on every store read, and useSyncExternalStore compares
  // with Object.is — that is an infinite render loop.
  const allProbes = useStore((s) => s.doc.probes);
  const probes = useMemo(
    () => allProbes.filter((p) => p.objectId === id),
    [allProbes, id],
  );
  const runtime = useStore((s) => s.runtime);
  const running = useStore((s) => s.session.state === 'running');
  const nodeStyle = useStore((s) => activePage(s.doc).canvas.nodeStyle ?? 'glyph');
  const pageGlyphVariant = useStore((s) => activePage(s.doc).canvas.glyphVariant ?? 'outline');
  // The card waits a beat so a cursor crossing the canvas does not strobe
  // cards, and a drag never grows one mid-move.
  const [hover, setHover] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const cardEnter = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHover(true), 250);
  };
  const cardLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(false);
  };
  useEffect(() => () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
  }, []);
  const ground = useStore((s) => s.settings.ground);
  const editingNow = useStore((s) => s.editingNodeId === id);
  const hit = useStore((s) => s.canvasHighlight?.has(id) ?? false);
  const dimmed = useStore((s) => (s.canvasHighlight ? !s.canvasHighlight.has(id) : false));
  const beginEditing = useStore((s) => s.beginEditing);
  const colourBy = useStore((s) => activePage(s.doc).canvas.colourBy ?? 'health');
  const rename = useStore((s) => s.updateNodeData);
  const openLink = () => {
    if (d.link) ipc.openExternalUrl(d.link).catch((err: unknown) => console.error(err));
  };

  // LT-159/160: a stack, a chassis pair or a device marked HA reads as several
  // boxes at a glance.
  const stacked = drawsStacked(d);
  // LT-168: outline or solid, the page's choice unless the device has its own.
  const solid = (d.style?.glyphVariant ?? pageGlyphVariant) === 'solid';
  // Health when something is watching, otherwise what the device is. A
  // diagram nobody has pointed at anything yet is a drawing, and an all-grey
  // drawing is a worse drawing.
  // Health is the default and is what the app is for. Colouring by subnet or
  // by tag answers a different question, and while it is on it wins — a
  // diagram cannot say two things with one colour.
  const grouped = colourBy !== 'health' ? keyForData(d, colourBy) : null;
  const color = grouped
    ? colourForKey(grouped, ground)
    : deviceColor(d.deviceType, status, ground);
  // The status line reports health and must not borrow the device's own
  // colour, or a blue switch reads as though blue meant something. When
  // nothing is watching it says so quietly rather than in the device's paint.
  const statusInk =
    status === 'unknown' ? 'var(--text-faint)' : statusColors(ground)[status];
  const amber = statusColors(ground).warning;
  const primary = probes.find((p) => p.isPrimary && p.enabled) ?? probes.find((p) => p.enabled);
  const live = primary ? runtime.get(primary.id) : undefined;
  const card =
    running && live && hover ? (
      <LiveCard label={d.label} status={status} ink={statusInk} live={live} />
    ) : null;
  // The native tooltip yields to the card — both at once says one thing twice.
  const hoverTitle = running && live ? undefined : `${d.label} — ${STATUS_LABEL[status]}`;
  const address =
    d.addresses?.find((a) => a.isPrimary)?.address ?? d.addresses?.[0]?.address ?? '';
  // A device with no name of its own is labelled with its address, and showing
  // that address again underneath is the same string twice.
  const primaryAddress = address === d.label ? '' : address;

  // A device that has stopped answering but has not yet failed enough times
  // to be called down. It is still drawn as healthy, because that is what the
  // rule says — but drawn as *confirmed* healthy it is a claim the app cannot
  // stand behind, and for the fifteen seconds the default thresholds take, a
  // device someone has just unplugged looks perfectly fine.
  const missed = live && live.consecutiveFailures > 0 ? live.consecutiveFailures : 0;
  const failing = missed > 0 && status !== 'down' && status !== 'disabled';
  const missedLabel = failing ? `${missed} of ${live?.failureThreshold ?? '?'} missed` : null;

  const isShape = SHAPE_DEVICE_TYPES.has(d.deviceType);
  const isText = d.deviceType === 'text';
  // The annotation shapes are boxes by definition — a rectangle drawn as a
  // glyph is not a rectangle — so they keep the drawn form either way.
  const glyph = nodeStyle === 'glyph' && !isShape && !isText;

  if (glyph) {
    return (
      <div
        className={`cv-glyph-node ${selected ? 'is-selected' : ''}${hit ? ' is-hit' : ''}${dimmed ? ' is-dimmed' : ''}`}
        title={hoverTitle}
        onMouseEnter={cardEnter}
        onMouseLeave={cardLeave}
      >
        {card}
        {/* What the pointer actually lands on (LT-120).
            A glyph is a symbol drawn inside a square box, and the box used to
            capture the pointer across the whole of it — corners and margins
            included, where nothing is drawn. A link running behind a device
            was unreachable there, which is why one crossing a device could not
            be selected. This is the device's hit area, and it is round,
            matching the ring that marks it as selected: what you can click is
            what looks like the device. The corners fall through to whatever is
            underneath, which is the link. */}
        <div className="cv-glyph-hit" />
        <NodeResizer
          isVisible={Boolean(selected) && !d.locked}
          keepAspectRatio
          minWidth={36}
          minHeight={36}
          lineClassName="cv-resize-line"
          handleClassName="cv-resize-handle"
        />
        <Handle type="source" position={Position.Top} id="t" className="cv-handle" />
        <Handle type="source" position={Position.Right} id="r" className="cv-handle" />
        <Handle type="source" position={Position.Bottom} id="b" className="cv-handle" />
        <Handle type="source" position={Position.Left} id="l" className="cv-handle" />

        <div
          className={`cv-glyph-art${failing ? ' is-failing' : ''}`}
          style={{ color: d.style?.iconColor ?? color }}
        >
          {d.imageDataUrl ? (
            <img src={d.imageDataUrl} alt="" />
          ) : (
            <DeviceGlyph type={d.deviceType} stacked={stacked} solid={solid} color={d.style?.iconColor ?? color} />
          )}
          <span
            key={status}
            className="cv-glyph-badge cv-status-pulse"
            style={{ background: color }}
            title={`${STATUS_LABEL[status]}${live?.lastSummary ? ` — ${live.lastSummary}` : ''}`}
          >
            <span aria-hidden>{STATUS_GLYPH[status]}</span>
            <span className="cv-sr">{STATUS_LABEL[status]}</span>
          </span>
          {d.locked && <span className="cv-glyph-lock" title="Locked" aria-label="Locked">🔒</span>}
          {openThreads(d.comments) > 0 && (
            <span className="cv-comment-badge" title="Open comments" aria-label={`${openThreads(d.comments)} open comments`}>
              💬 {openThreads(d.comments)}
            </span>
          )}
          {d.link && (
            <span
              className="cv-glyph-link nodrag nopan"
              title={d.link}
              aria-label={`Open ${d.link}`}
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                openLink();
              }}
            >
              🔗
            </span>
          )}
        </div>

        {/* Text sits under the glyph and is allowed to be wider than it, so
            adding an address moves nothing and resizes nothing. */}
        <div className="cv-glyph-text">
          <EditableLabel
            className="cv-glyph-label"
            style={cssOf(d.labelStyle)}
            value={d.label}
            onCommit={(label) => rename(id, { label })}
            startEditing={editingNow}
            onStarted={() => beginEditing(null)}
          />
          {d.showDetails && (
            <>
              {primaryAddress && <div className="cv-glyph-addr">{primaryAddress}</div>}
              <div className="cv-glyph-status" style={{ color: failing ? amber : statusInk }}>
                {STATUS_LABEL[status]}
                {missedLabel
                  ? ` · ${missedLabel}`
                  : live?.lastRttMs != null && status !== 'down'
                    ? ` · ${live.lastRttMs < 1 ? '<1' : live.lastRttMs.toFixed(0)} ms`
                    : ''}
              </div>
              {d.maintenance && <div className="cv-node-maint">In maintenance</div>}
            </>
          )}
        </div>
      </div>
    );
  }

  const isZone = d.deviceType === 'zone';
  const outline = OUTLINES[d.deviceType];
  const strokeColor = selected ? canvasPalette(ground).selection : (d.style?.border ?? color);

  return (
    <div
      className={`cv-node ${isShape ? 'cv-node-shape' : ''} ${isZone ? 'cv-zone' : ''} ${
        selected ? 'is-selected' : ''
      }${hit ? ' is-hit' : ''}${dimmed ? ' is-dimmed' : ''}`}
      data-shape={d.deviceType}
      data-boundary={isZone && isBoundaryKind(d.boundaryKind) ? d.boundaryKind : undefined}
      style={{
        // A shape with its own outline must not also draw the box's border,
        // and an inline colour would beat the stylesheet rule that hides it.
        borderColor: outline || isText ? 'transparent' : strokeColor,
        // LT-166: each kind of boundary has its own dash, so kinds differ
        // without relying on colour. CSS cannot draw a dash pattern on a
        // border, so the pattern is carried to the outline below.
        ...(isZone && isBoundaryKind(d.boundaryKind) ? { borderStyle: 'none' } : {}),
        background: outline ? 'transparent' : (d.style?.background ?? undefined),
      }}
      title={hoverTitle}
      onMouseEnter={cardEnter}
      onMouseLeave={cardLeave}
    >
      {card}
      {isZone && isBoundaryKind(d.boundaryKind) && (
        <svg className="cv-boundary-outline" aria-hidden>
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            rx="10"
            fill="none"
            stroke={strokeColor}
            strokeWidth={selected ? 2.5 : 1.5}
            strokeDasharray={selected ? undefined : BOUNDARIES[d.boundaryKind].dash}
          />
        </svg>
      )}
      {outline && (
        <svg
          className="cv-node-outline"
          viewBox="0 0 200 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          <path
            d={outline}
            fill={d.style?.background ?? 'none'}
            stroke={strokeColor}
            strokeWidth={selected ? 3 : 2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <NodeResizer
        isVisible={Boolean(selected) && !d.locked}
        minWidth={80}
        minHeight={56}
        lineClassName="cv-resize-line"
        handleClassName="cv-resize-handle"
      />

      {/* A label is not something a cable plugs into (LT-049). */}
      {!isText && (
        <>
          <Handle type="source" position={Position.Top} id="t" className="cv-handle" />
          <Handle type="source" position={Position.Right} id="r" className="cv-handle" />
          <Handle type="source" position={Position.Bottom} id="b" className="cv-handle" />
          <Handle type="source" position={Position.Left} id="l" className="cv-handle" />
        </>
      )}

      {!isText && (
        <span
          // Re-keying on status remounts the badge, which retriggers the CSS
          // pulse below. A state change gets a brief, cheap acknowledgement.
          key={status}
          className="cv-status-badge cv-status-pulse"
          style={{ background: color }}
          title={`${STATUS_LABEL[status]}${live?.lastSummary ? ` — ${live.lastSummary}` : ''}`}
        >
          <span aria-hidden>{STATUS_GLYPH[status]}</span>
          <span className="cv-sr">{STATUS_LABEL[status]}</span>
        </span>
      )}

      {d.locked && (
        <span className="cv-lock" title="Locked" aria-label="Locked">
          🔒
        </span>
      )}
      {d.link && (
        <span
          className="cv-node-link nodrag nopan"
          title={d.link}
          aria-label={`Open ${d.link}`}
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            openLink();
          }}
        >
          🔗
        </span>
      )}

      <div className="cv-node-body">
        {!isShape && (
          <div className="cv-node-icon" style={{ color: d.style?.iconColor ?? color }}>
            {d.imageDataUrl ? (
              <img src={d.imageDataUrl} alt="" className="cv-node-image" />
            ) : (
              <DeviceGlyph type={d.deviceType} stacked={stacked} solid={solid} color={d.style?.iconColor ?? color} />
            )}
          </div>
        )}
        <div className="cv-node-text">
          {/* LT-166: what kind of area, and which one. */}
          {isZone && boundaryChip(d) && (
            <span
              className={`cv-boundary-chip${
                isBoundaryKind(d.boundaryKind) && boundaryIdProblem(d.boundaryKind, d.boundaryId) ? ' is-invalid' : ''
              }`}
            >
              {boundaryChip(d)}
            </span>
          )}
          <EditableLabel
            className="cv-node-label"
            style={cssOf(d.labelStyle)}
            multiline={d.deviceType === 'text' || d.deviceType === 'callout'}
            value={d.label}
            onCommit={(label) => rename(id, { label })}
            startEditing={editingNow}
            onStarted={() => beginEditing(null)}
          />
          {d.showDetails && !isText && (
            <div className="cv-node-detail">
              {primaryAddress && <div className="cv-mono">{primaryAddress}</div>}
              <div className="cv-node-status-line" style={{ color: failing ? amber : statusInk }}>
                {STATUS_LABEL[status]}
                {missedLabel
                  ? ` · ${missedLabel}`
                  : live?.lastRttMs != null && status !== 'down'
                    ? ` · ${live.lastRttMs < 1 ? '<1' : live.lastRttMs.toFixed(0)} ms`
                    : ''}
              </div>
              {d.maintenance && <div className="cv-node-maint">In maintenance</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const DeviceNode = memo(DeviceNodeInner);
