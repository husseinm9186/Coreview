import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULTS, deviceColor } from '../../theme';

import { useStore } from '../../state/store';
import { InventorySection } from './InventorySection';
import { ProbeHistory } from './ProbeHistory';
import { AttachmentsSection, NeighboursSection } from './DeviceRelations';
import { PortView } from './PortView';
import { CommentsSection } from './CommentsSection';
import { probeFromTemplate, templateFromProbe } from '../../lib/probeTemplates';
import { SavedCredentialSelect } from '../CredentialPicker';
import { portNames } from '../../lib/shapeCatalog';
import { MAX_TEXT_SIZE, MIN_TEXT_SIZE, isStyled, safeSize, type TextAlign, type TextStyle } from '../../lib/textStyle';
import { CABLES, CABLE_TYPES, isCableType } from '../../lib/cables';
import { BOUNDARIES, BOUNDARY_KINDS, boundaryIdProblem, isBoundaryKind } from '../../lib/boundaries';
import { uid } from '../../lib/id';
import { serialCount } from '../../lib/serials';
import { newProbe } from '../../lib/probes';
import { spanOf } from '../../lib/dtg';
import { formatTime, isLocalFormat, zoneLabel } from '../../lib/timeFormat';
import { DEVICE_LABEL } from '../icons';
import { STATUS_COLOR } from '../edges/LiveEdge';
import { describeRule, linkStatus } from '../../health/evaluate';
import { describeSelection, shared, withTag, withoutTag } from '../../lib/bulkEdit';
import type { Shared } from '../../lib/bulkEdit';
import { buildTimeline, shortDuration, totals } from '../../lib/statusHistory';
import { capsFor } from '../../lib/linkStyle';
import { layersOf, toggleOn } from '../../lib/layers';
import { activePage } from '../../lib/pages';
import type {
  DeviceNodeData,
  DeviceType,
  LinkData,
  LinkHealthRuleType,
  NoteNodeData,
  Probe,
  ProbeKind,
} from '../../types/domain';
import {
  HEALTH_RULE_LABEL,
  PROBE_DEFAULTS,
  STATUS_GLYPH,
  STATUS_LABEL,
} from '../../types/domain';

const CAP_OPTIONS: [string, string][] = [
  ['none', 'Nothing'],
  ['arrow', 'Arrow'],
  ['open-arrow', 'Open arrow'],
  ['circle', 'Circle'],
  ['square', 'Square'],
  ['diamond', 'Diamond'],
];

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="cv-field">
      <span className="cv-field-label">{label}</span>
      {children}
      {hint && <span className="cv-field-hint">{hint}</span>}
    </label>
  );
}

/** A colour override with a way back to automatic (LT-102). `isSet` decides
 *  whether "Reset" shows — the swatch itself cannot tell a real override
 *  from the automatic colour it happens to match. */
function ColorField({
  label,
  value,
  isSet,
  hint,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  isSet: boolean;
  hint?: string;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="cv-row cv-row-tight">
        <input className="cv-color" type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        {isSet && (
          <button type="button" className="cv-link" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
    </Field>
  );
}

/**
 * A label's text style (LT-181): bold and italic, size, colour, background and —
 * where a label has room to be aligned — alignment. Empty fields mean the
 * label's own defaults; clearing everything removes the style altogether.
 */
function TextStyleFields({
  title,
  value,
  onChange,
  allowAlign = false,
  defaultColor,
  defaultBackground,
}: {
  title: string;
  value: TextStyle | undefined;
  onChange: (next: TextStyle | undefined) => void;
  allowAlign?: boolean;
  defaultColor: string;
  defaultBackground: string;
}) {
  const t = value ?? {};
  // Closed unless the label already has a style: a link's inspector would
  // otherwise open with two rows of text controls above its own colour.
  const [open, setOpen] = useState(() => isStyled(value));
  const set = (patch: Partial<TextStyle>) => {
    const next: TextStyle = { ...t, ...patch };
    for (const k of Object.keys(next) as (keyof TextStyle)[]) {
      if (next[k] === undefined || next[k] === false || next[k] === '') delete next[k];
    }
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <details
      className="cv-text-style"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cv-field-label">
        {title}
        {isStyled(value) ? ' · styled' : ''}
      </summary>
      {open && (
      <div role="group" aria-label={title}>
      <div className="cv-row cv-row-tight">
        <button
          type="button"
          className={`cv-btn cv-btn-small${t.bold ? ' is-active' : ''}`}
          aria-pressed={Boolean(t.bold)}
          title="Bold"
          onClick={() => set({ bold: !t.bold })}
        >
          <b>B</b>
        </button>
        <button
          type="button"
          className={`cv-btn cv-btn-small${t.italic ? ' is-active' : ''}`}
          aria-pressed={Boolean(t.italic)}
          title="Italic"
          onClick={() => set({ italic: !t.italic })}
        >
          <i>I</i>
        </button>
        <input
          className="cv-input cv-input-narrow"
          type="number"
          min={MIN_TEXT_SIZE}
          max={MAX_TEXT_SIZE}
          placeholder="Size"
          aria-label={`${title} size`}
          value={t.size ?? ''}
          onChange={(e) => set({ size: e.target.value === '' ? undefined : safeSize(Number(e.target.value)) })}
        />
        {allowAlign && (
          <select
            className="cv-input"
            aria-label={`${title} alignment`}
            value={t.align ?? 'center'}
            onChange={(e) => set({ align: e.target.value === 'center' ? undefined : (e.target.value as TextAlign) })}
          >
            <option value="left">Left</option>
            <option value="center">Centre</option>
            <option value="right">Right</option>
          </select>
        )}
      </div>
      <div className="cv-row">
        <ColorField
          label="Colour"
          value={t.color ?? defaultColor}
          isSet={Boolean(t.color)}
          onChange={(v) => set({ color: v })}
          onReset={() => set({ color: undefined })}
        />
        <ColorField
          label="Background"
          value={t.background ?? defaultBackground}
          isSet={Boolean(t.background)}
          onChange={(v) => set({ background: v })}
          onReset={() => set({ background: undefined })}
        />
      </div>
      </div>
      )}
    </details>
  );
}

export function Inspector() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectedEdgeId = useStore((s) => s.selectedEdgeId);
  const meta = useStore((s) => s.meta);
  const nodes = useStore((s) => activePage(s.doc).nodes);
  const edges = useStore((s) => activePage(s.doc).edges);

  const many = nodes.filter((n) => n.selected);
  const manyLinks = edges.filter((e) => e.selected);

  if (!meta) return null;

  return (
    <aside className="cv-inspector" aria-label="Inspector">
      {many.length > 1 ? (
        <MultiInspector ids={many.map((n) => n.id)} />
      ) : manyLinks.length > 1 && many.length === 0 ? (
        <MultiLinkInspector ids={manyLinks.map((e) => e.id)} />
      ) : selectedNodeId ? (
        <NodeInspector nodeId={selectedNodeId} />
      ) : selectedEdgeId ? (
        <LinkInspector edgeId={selectedEdgeId} />
      ) : (
        <ProjectInspector />
      )}
    </aside>
  );
}

/** LT-236: a text field for a whole selection. Shows the shared value, or
 *  says the selection is mixed; sets every device only when it is changed and
 *  left, or Enter is pressed. */
function BulkText({ label, shared: value, onSet }: { label: string; shared: Shared<string>; onSet: (v: string) => void }) {
  const current = value.kind === 'same' ? value.value : '';
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);
  const commit = () => {
    if (value.kind === 'same' && text.trim() === current) return;
    if (value.kind === 'mixed' && text.trim() === '') return;
    onSet(text.trim());
  };
  return (
    <Field label={label} hint={value.kind === 'mixed' ? 'Mixed — typing sets them all' : undefined}>
      <input
        className="cv-input"
        aria-label={`${label} for every selected device`}
        value={text}
        placeholder={value.kind === 'mixed' ? 'Mixed' : ''}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </Field>
  );
}

/** LT-236: several links at once — cable, path, line style, width, colour. */
function MultiLinkInspector({ ids }: { ids: string[] }) {
  const edges = useStore((s) => activePage(s.doc).edges);
  const updateMany = useStore((s) => s.updateManyEdgeData);
  const chosen = edges.filter((e) => ids.includes(e.id)).map((e) => (e.data ?? {}) as LinkData);
  const cable = shared(chosen.map((d) => d.cableType ?? ''));
  const path = shared(chosen.map((d) => d.pathType ?? 'smoothstep'));
  const style = shared(chosen.map((d) => d.lineStyle ?? 'auto'));
  const width = shared(chosen.map((d) => d.width ?? 2));
  const mixed = (x: Shared<unknown>) => x.kind === 'mixed';
  return (
    <>
      <h2 className="cv-inspector-title">
        {ids.length} links selected
      </h2>
      <Field label="Cable" hint={mixed(cable) ? 'Mixed — choosing one sets them all' : undefined}>
        <select className="cv-input" aria-label="Cable for every selected link" value={cable.kind === 'same' ? cable.value : '__mixed'}
          onChange={(e) => updateMany(ids, { cableType: isCableType(e.target.value) ? e.target.value : undefined }, 'Set cable')}>
          {mixed(cable) && <option value="__mixed" disabled>Mixed</option>}
          <option value="">Not set</option>
          {CABLE_TYPES.map((c) => <option key={c} value={c}>{CABLES[c].label}</option>)}
        </select>
      </Field>
      <Field label="Path" hint={mixed(path) ? 'Mixed — choosing one sets them all' : undefined}>
        <select className="cv-input" aria-label="Path for every selected link" value={path.kind === 'same' ? path.value : '__mixed'}
          onChange={(e) => updateMany(ids, { pathType: e.target.value as LinkData['pathType'] }, 'Set path')}>
          {mixed(path) && <option value="__mixed" disabled>Mixed</option>}
          <option value="smoothstep">Right angles, rounded</option>
          <option value="step">Right angles</option>
          <option value="straight">Straight</option>
          <option value="bezier">Curved</option>
          <option value="avoid">Around devices</option>
        </select>
      </Field>
      <div className="cv-row">
        <Field label="Line" hint={mixed(style) ? 'Mixed' : undefined}>
          <select className="cv-input" aria-label="Line style for every selected link" value={style.kind === 'same' ? style.value : '__mixed'}
            onChange={(e) => updateMany(ids, { lineStyle: e.target.value as LinkData['lineStyle'] }, 'Set line style')}>
            {mixed(style) && <option value="__mixed" disabled>Mixed</option>}
            <option value="auto">By status</option>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dash-dot">Dash-dot</option>
          </select>
        </Field>
        <Field label="Width" hint={mixed(width) ? 'Mixed' : undefined}>
          <input className="cv-input" type="number" min={1} max={12} aria-label="Width for every selected link"
            value={width.kind === 'same' ? width.value : ''} placeholder={mixed(width) ? 'Mixed' : ''}
            onChange={(e) => e.target.value && updateMany(ids, { width: Math.max(1, Math.min(12, Number(e.target.value))) }, 'Set width')} />
        </Field>
      </div>
      <p className="cv-help">Each change is one undo step for all {ids.length} links.</p>
    </>
  );
}

/**
 * Editing a whole selection at once.
 *
 * A crawl puts dozens of devices on the canvas. Retyping a site tag forty
 * times is what makes people give up on a tool, so this exists — but a bulk
 * editor that overwrites what it was not asked about is worse than none.
 * Nothing here changes a field until that field is used, and a value the
 * selection disagrees on says so rather than showing the first one.
 */
function MultiInspector({ ids }: { ids: string[] }) {
  const nodes = useStore((s) => activePage(s.doc).nodes);
  const updateMany = useStore((s) => s.updateManyNodeData);
  const mapMany = useStore((s) => s.mapManyNodeData);
  const templates = useStore((s) => s.doc.probeTemplates) ?? [];
  const applyTemplate = useStore((s) => s.applyProbeTemplate);
  const [newTag, setNewTag] = useState('');

  const chosen = useMemo(() => {
    const wanted = new Set(ids);
    return nodes.filter((n) => wanted.has(n.id));
  }, [nodes, ids]);
  const sel = useMemo(() => describeSelection(chosen), [chosen]);

  const deviceIds = sel.devices.map((n) => n.id);
  const addTag = () => {
    const tag = newTag.trim();
    if (tag === '') return;
    mapMany(deviceIds, (d) => ({ tags: withTag(d.tags, tag) }), `Tag ${tag}`);
    setNewTag('');
  };

  // Every device keeps its own automatic colour by default (different types,
  // different statuses), so there is no single swatch to show for "not set" —
  // a neutral placeholder stands in until an override is actually chosen.
  const NEUTRAL_SWATCH = '#64748b';
  const bulkColorValue = (field: Shared<string | undefined>) =>
    field.kind === 'same' && field.value ? field.value : NEUTRAL_SWATCH;
  const setBulkColor = (key: 'iconColor' | 'background' | 'border', value: string) =>
    mapMany(deviceIds, (d) => ({ style: { ...(d as DeviceNodeData).style, [key]: value } }), `Set ${key}`);
  const resetBulkColor = (key: 'iconColor' | 'background' | 'border') =>
    mapMany(
      deviceIds,
      (d) => {
        const next = { ...(d as DeviceNodeData).style };
        delete next[key];
        return { style: next };
      },
      `Reset ${key}`,
    );

  return (
    <>
      <h2 className="cv-inspector-title">
        {chosen.length} selected
        <span className="cv-inspector-sub">
          {sel.devices.length} device{sel.devices.length === 1 ? '' : 's'}
          {sel.notes.length > 0 && `, ${sel.notes.length} note${sel.notes.length === 1 ? '' : 's'}`}
        </span>
      </h2>

      {sel.devices.length === 0 ? (
        <p className="cv-field-hint">
          Notes have nothing in common to edit together. Select them one at a time.
        </p>
      ) : (
        <>
          <Field
            label="Device type"
            hint={
              sel.deviceType.kind === 'mixed'
                ? 'The selection is mixed — choosing one sets them all'
                : undefined
            }
          >
            <select
              className="cv-input"
              value={sel.deviceType.kind === 'same' ? sel.deviceType.value : ''}
              onChange={(e) =>
                updateMany(
                  deviceIds,
                  { deviceType: e.target.value as DeviceType },
                  'Set device type',
                )
              }
            >
              {sel.deviceType.kind === 'mixed' && (
                <option value="" disabled>
                  Mixed
                </option>
              )}
              {Object.entries(DEVICE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>

          {/* LT-222: one saved check, added to every selected device. */}
          {templates.length > 0 && (
            <Field label="Add a check from a template" hint="Each device gets its own, aimed at its primary address">
              <select
                className="cv-input"
                aria-label="Add a check from a template to the selection"
                value=""
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  if (!t) return;
                  const got = applyTemplate(t.id, deviceIds);
                  useStore.getState().setStatusMessage(
                    `Added ${t.name} to ${got.added} device${got.added === 1 ? '' : 's'}` +
                      (got.skipped.length ? `; ${got.skipped.join(', ')} ${got.skipped.length === 1 ? 'has' : 'have'} no address.` : '.'),
                  );
                }}
              >
                <option value="">Choose a template…</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}

          {/* LT-236: text every selected device can share. */}
          <div className="cv-row">
            {([['Role', 'role'], ['Site', 'site']] as const).map(([label, key]) => (
              <BulkText key={key} label={label} shared={sel[key]} onSet={(v) => updateMany(deviceIds, { [key]: v || undefined }, `Set ${key}`)} />
            ))}
          </div>
          <div className="cv-row">
            {([['Rack / room', 'rack'], ['Vendor', 'vendor']] as const).map(([label, key]) => (
              <BulkText key={key} label={label} shared={sel[key]} onSet={(v) => updateMany(deviceIds, { [key]: v || undefined }, `Set ${key}`)} />
            ))}
          </div>

          <Field label="Add a tag" hint="Applied to every selected device that lacks it">
            <div className="cv-row cv-row-tight">
              <input
                className="cv-input"
                value={newTag}
                placeholder="site-hq"
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
              <button type="button" className="cv-btn cv-btn-small" onClick={addTag}>
                Add
              </button>
            </div>
          </Field>

          {sel.commonTags.length > 0 && (
            <Field label="Tags on all of them" hint="Click to remove from every selected device">
              <div className="cv-tag-row">
                {sel.commonTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="cv-tag"
                    title={`Remove ${tag} from all ${deviceIds.length}`}
                    onClick={() =>
                      mapMany(deviceIds, (d) => ({ tags: withoutTag(d.tags, tag) }), `Untag ${tag}`)
                    }
                  >
                    {tag} ×
                  </button>
                ))}
              </div>
            </Field>
          )}

          {sel.someTags.length > 0 && (
            <Field
              label="Tags on some of them"
              hint="Left alone. Removing a tag half the selection does not carry is rarely what anyone means"
            >
              <div className="cv-tag-row">
                {sel.someTags.map((tag) => (
                  <span key={tag} className="cv-tag is-partial">
                    {tag}
                  </span>
                ))}
              </div>
            </Field>
          )}

          <div className="cv-row">
            <ColorField
              label="Icon"
              value={bulkColorValue(sel.iconColor)}
              isSet={sel.iconColor.kind === 'same' && !!sel.iconColor.value}
              hint={sel.iconColor.kind === 'mixed' ? 'Mixed — choosing one sets them all' : undefined}
              onChange={(v) => setBulkColor('iconColor', v)}
              onReset={() => resetBulkColor('iconColor')}
            />
            <ColorField
              label="Background"
              value={bulkColorValue(sel.background)}
              isSet={sel.background.kind === 'same' && !!sel.background.value}
              hint={sel.background.kind === 'mixed' ? 'Mixed — choosing one sets them all' : undefined}
              onChange={(v) => setBulkColor('background', v)}
              onReset={() => resetBulkColor('background')}
            />
            <ColorField
              label="Border"
              value={bulkColorValue(sel.border)}
              isSet={sel.border.kind === 'same' && !!sel.border.value}
              hint={sel.border.kind === 'mixed' ? 'Mixed — choosing one sets them all' : undefined}
              onChange={(v) => setBulkColor('border', v)}
              onReset={() => resetBulkColor('border')}
            />
          </div>

          <BulkLayers ids={chosen.map((n) => n.id)} sel={sel} />

          <div className="cv-checks">
            <TriCheck
              label="Lock position"
              state={sel.locked}
              onSet={(v) => updateMany(deviceIds, { locked: v }, v ? 'Lock' : 'Unlock')}
            />
            <TriCheck
              label="Maintenance — suppress status"
              state={sel.maintenance}
              onSet={(v) => updateMany(deviceIds, { maintenance: v }, 'Set maintenance')}
            />
            <TriCheck
              label="Show address and status on the canvas"
              state={sel.showDetails}
              onSet={(v) => updateMany(deviceIds, { showDetails: v }, 'Set detail')}
            />
          </div>
        </>
      )}
    </>
  );
}

/**
 * Putting a whole selection on a view, or taking it off one.
 *
 * A crawl puts dozens of devices down at once, and the reason to have views at
 * all is to say "these forty are the physical layer". One at a time is the
 * work the bulk editor exists to remove.
 */
function BulkLayers({
  ids,
  sel,
}: {
  ids: string[];
  sel: { commonLayers: string[]; someLayers: string[] };
}) {
  const canvas = useStore((s) => activePage(s.doc).canvas);
  const mapMany = useStore((s) => s.mapManyNodeData);
  const layers = layersOf(canvas.layers);
  if (layers.length < 2) return null;

  return (
    <Field
      label="Appears on"
      hint="Click to put the whole selection on a view, or take it off one"
    >
      <div className="cv-tag-row">
        {layers.map((layer) => {
          const all = sel.commonLayers.includes(layer.id);
          const some = sel.someLayers.includes(layer.id);
          return (
            <button
              key={layer.id}
              type="button"
              className={`cv-tag${all ? '' : ' is-partial'}`}
              title={
                all
                  ? `Take the selection off ${layer.name}`
                  : `Put the selection on ${layer.name}`
              }
              onClick={() =>
                mapMany(
                  ids,
                  (d) => ({
                    // Everything on it comes off; anything else goes on. A
                    // half-assigned selection is made uniform rather than
                    // toggled item by item, which would leave it half-assigned
                    // the other way round.
                    layers: all
                      ? withoutLayer_(d.layers, layer.id)
                      : withLayer_(d.layers, layer.id),
                  }),
                  all ? `Off ${layer.name}` : `On ${layer.name}`,
                )
              }
            >
              {layer.name}
              {some && !all ? ' ·' : ''}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

const withLayer_ = (on: string[] | undefined, id: string): string[] =>
  (on ?? []).includes(id) ? (on ?? []) : [...(on ?? []), id];
const withoutLayer_ = (on: string[] | undefined, id: string): string[] =>
  (on ?? []).filter((l) => l !== id);

/** A checkbox with a third state for "the selection disagrees".
 *
 *  An indeterminate box that clears on the first click would turn every locked
 *  device in a mixed selection loose without saying so. The first click always
 *  turns the setting on; unticking then turns it off. */
function TriCheck({
  label,
  state,
  onSet,
}: {
  label: string;
  state: { kind: 'same'; value: boolean } | { kind: 'mixed' } | { kind: 'none' };
  onSet: (value: boolean) => void;
}) {
  const checked = state.kind === 'same' && state.value;
  return (
    <label className="cv-check">
      <input
        type="checkbox"
        checked={checked}
        ref={(el) => {
          if (el) el.indeterminate = state.kind === 'mixed';
        }}
        onChange={(e) => onSet(state.kind === 'mixed' ? true : e.target.checked)}
      />
      {label}
      {state.kind === 'mixed' && <span className="cv-field-hint"> — mixed</span>}
    </label>
  );
}

const WINDOWS: { label: string; ms: number }[] = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '6h', ms: 6 * 60 * 60_000 },
];

/**
 * What this device's status has been, as a strip.
 *
 * A single dot says what a device is doing now. It cannot say whether it has
 * been solid all afternoon or has dropped out four times, and that difference
 * is usually the whole question. The strip is built from recorded transitions,
 * so the periods nobody was watching are drawn as unknown rather than filled
 * in with whatever the device happens to be doing at the moment.
 */
function StatusStrip({ nodeId }: { nodeId: string }) {
  const events = useStore((s) => s.events);
  const session = useStore((s) => s.session);
  const status = useStore((s) => s.nodeStatus(nodeId));
  const [windowMs, setWindowMs] = useState(WINDOWS[1]!.ms);
  const timeFormat = useStore((s) => s.settings.timeFormat);
  // A single clock for the whole render, so the spans and the axis agree.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const spans = useMemo(
    () =>
      buildTimeline({
        events,
        objectId: nodeId,
        fromMs: now - windowMs,
        toMs: now,
        current: status,
        sessionStartedAt: session.startedAt,
      }),
    [events, nodeId, now, windowMs, status, session.startedAt],
  );

  const summary = useMemo(() => totals(spans), [spans]);
  const span = Math.max(1, windowMs);

  // LT-099: a scrub line follows the pointer across the strip rather than
  // only offering the coarse, per-segment native tooltip — and clicking
  // the strip enlarges it, since 12px tall is plenty to glance at but not
  // enough to read closely.
  const [expanded, setExpanded] = useState(false);
  const [scrubAt, setScrubAt] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const scrubbed = useMemo(() => {
    if (scrubAt === null) return null;
    const atMs = now - windowMs + scrubAt * windowMs;
    const hit = spans.find((s) => atMs >= s.fromMs && atMs <= s.toMs) ?? spans[spans.length - 1];
    return hit ? { atMs, status: hit.status } : null;
  }, [scrubAt, now, windowMs, spans]);

  const scrubTo = (clientX: number) => {
    const rect = stripRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setScrubAt(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  return (
    <div className="cv-history">
      <div className="cv-history-head">
        <span className="cv-field-label">Recent status</span>
        <div className="cv-history-windows">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              className={w.ms === windowMs ? 'is-at' : ''}
              onClick={() => setWindowMs(w.ms)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={stripRef}
        className={`cv-history-strip${expanded ? ' is-expanded' : ''}`}
        role="img"
        aria-label={summary
          .map((t) => `${STATUS_LABEL[t.status]} ${shortDuration(t.ms)}`)
          .join(', ')}
        title="Click to enlarge"
        onClick={() => setExpanded((e) => !e)}
        onPointerMove={(e) => scrubTo(e.clientX)}
        onPointerLeave={() => setScrubAt(null)}
      >
        {spans.map((s) => (
          <span
            key={`${s.fromMs}-${s.status}`}
            style={{
              width: `${((s.toMs - s.fromMs) / span) * 100}%`,
              background: STATUS_COLOR[s.status],
            }}
            title={`${STATUS_LABEL[s.status]} — ${shortDuration(s.toMs - s.fromMs)}`}
          />
        ))}
        {scrubAt !== null && (
          <i className="cv-history-scrub" style={{ left: `${scrubAt * 100}%` }} />
        )}
      </div>
      <p className="cv-field-hint cv-history-scrub-readout">
        {scrubbed
          ? `${formatTime(scrubbed.atMs, timeFormat)} — ${STATUS_LABEL[scrubbed.status]}`
          : 'Point at the strip for the exact time and status there.'}
      </p>

      <div className="cv-history-legend">
        {summary.length === 0 ? (
          <span className="cv-field-hint">Nothing recorded yet.</span>
        ) : (
          summary.map((t) => (
            <span key={t.status} className="cv-history-key">
              <i style={{ background: STATUS_COLOR[t.status] }} />
              {STATUS_LABEL[t.status]} {shortDuration(t.ms)}
            </span>
          ))
        )}
      </div>

      {/* LT-074: when it went, and when it came back — a date-time group per
          change, because "Down 7s" does not tell anyone which 7 seconds. The
          bars say how long; this says when. */}
      {spans.length > 1 && (
        <p className="cv-field-hint cv-history-zone">
          Times in {isLocalFormat(timeFormat) ? zoneLabel() : 'Zulu (UTC)'}
        </p>
      )}
      {spans.length > 1 && (
        <ul className={`cv-history-log${expanded ? ' is-expanded' : ''}`}>
          {spans
            .slice()
            .reverse()
            .slice(0, expanded ? 40 : 12)
            .map((s) => (
              <li key={`${s.fromMs}-${s.status}`}>
                <span className="cv-mono cv-history-dtg" title={new Date(s.fromMs).toISOString()}>
                  {formatTime(s.fromMs, timeFormat)}
                </span>
                <span style={{ color: STATUS_COLOR[s.status] }}>{STATUS_LABEL[s.status]}</span>
                <span className="cv-field-hint">{spanOf(s.fromMs, s.toMs)}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Which views an object appears on.
 *
 * Nothing ticked means every view, which is what an object that has never
 * been assigned is — and is why a diagram drawn before views existed still
 * shows everything.
 */
function LayerPicker({
  on,
  onChange,
}: {
  on: string[] | undefined;
  onChange: (next: string[]) => void;
}) {
  const canvas = useStore((s) => activePage(s.doc).canvas);
  const layers = layersOf(canvas.layers);
  if (layers.length < 2) return null;
  return (
    <Field
      label="Appears on"
      hint={!on || on.length === 0 ? 'Every view' : `${on.length} of ${layers.length} views`}
    >
      <div className="cv-tag-row">
        {layers.map((layer) => {
          const picked = Boolean(on?.includes(layer.id));
          return (
            <button
              key={layer.id}
              type="button"
              className={`cv-tag${picked ? '' : ' is-partial'}`}
              onClick={() => onChange(toggleOn(on, layer.id))}
              title={picked ? `Take off ${layer.name}` : `Put on ${layer.name}`}
            >
              {layer.name}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function ProjectInspector() {
  const meta = useStore((s) => s.meta)!;
  const updateMeta = useStore((s) => s.updateMeta);
  return (
    <>
      <h2 className="cv-inspector-title">Project</h2>
      <Field label="Project name">
        <input
          className="cv-input"
          value={meta.name}
          onChange={(e) => updateMeta({ name: e.target.value })}
        />
      </Field>
      <Field label="Customer or organisation">
        <input
          className="cv-input"
          value={meta.customer}
          onChange={(e) => updateMeta({ customer: e.target.value })}
        />
      </Field>
      <Field label="Site or location">
        <input
          className="cv-input"
          value={meta.site}
          onChange={(e) => updateMeta({ site: e.target.value })}
        />
      </Field>
      <Field label="Change ticket">
        <input
          className="cv-input"
          value={meta.ticket}
          onChange={(e) => updateMeta({ ticket: e.target.value })}
        />
      </Field>
      <Field label="Engineer">
        <input
          className="cv-input"
          value={meta.engineer}
          onChange={(e) => updateMeta({ engineer: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          className="cv-input"
          rows={4}
          value={meta.description}
          onChange={(e) => updateMeta({ description: e.target.value })}
        />
      </Field>
      <ProjectCheckTiming />

      <p className="cv-help">
        Select a node or a link to configure targets and health rules. Checks run from this
        machine only.
      </p>
    </>
  );
}

/**
 * The timing policy for every check in the project.
 *
 * "Tell me within fifteen seconds" is one decision, and setting it per probe
 * across ninety devices is not a decision, it is data entry. The two numbers
 * that decide it are here, together, with what they add up to spelled out —
 * an interval and a threshold multiply, and people read them separately.
 */
function ProjectCheckTiming() {
  const probes = useStore((s) => s.doc.probes);
  const setProbeTiming = useStore((s) => s.setProbeTiming);
  const setStatusMessage = useStore((s) => s.setStatusMessage);

  // The policy in force, when every probe agrees on one.
  const interval = probes.length ? probes[0]!.intervalSeconds : PROBE_DEFAULTS.intervalSeconds;
  const threshold = probes.length ? probes[0]!.failureThreshold : PROBE_DEFAULTS.failureThreshold;
  const mixed =
    probes.length > 1 &&
    probes.some((p) => p.intervalSeconds !== interval || p.failureThreshold !== threshold);

  const [everySeconds, setEverySeconds] = useState(interval);
  const [misses, setMisses] = useState(threshold);

  const apply = () => {
    const changed = setProbeTiming(everySeconds, misses);
    setStatusMessage(
      changed === 0
        ? 'Nothing to change — this project has no checks yet.'
        : `Every check now runs every ${everySeconds}s and needs ${misses} missed before a device is called down.`,
    );
  };

  return (
    <div className="cv-timing">
      <span className="cv-subnets-label">Checks</span>
      <div className="cv-timing-row">
        <label className="cv-field cv-field-narrow">
          <span>Every</span>
          <input className="cv-input" type="number" min={1} max={3600} value={everySeconds}
            onChange={(e) => setEverySeconds(Number(e.target.value) || 1)} />
        </label>
        <label className="cv-field cv-field-narrow">
          <span>Missed before down</span>
          <input className="cv-input" type="number" min={1} max={60} value={misses}
            onChange={(e) => setMisses(Number(e.target.value) || 1)} />
        </label>
      </div>
      <p className="cv-help">
        A device that stops answering is called down after about{' '}
        <strong>{everySeconds * misses} seconds</strong>. Missed checks show on the diagram
        straight away, before that.
        {mixed && ' These checks do not all agree today; applying this will make them.'}
      </p>
      <button type="button" className="cv-btn cv-btn-small" onClick={apply}
        disabled={probes.length === 0}>
        Apply to all {probes.length} check{probes.length === 1 ? '' : 's'}
      </button>
    </div>
  );
}

function NodeInspector({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => activePage(s.doc).nodes.find((n) => n.id === nodeId));
  const update = useStore((s) => s.updateNodeData);
  const status = useStore((s) => s.nodeStatus(nodeId));
  const ground = useStore((s) => s.settings.ground);

  if (!node) return null;

  if (node.type === 'note') {
    const d = node.data as NoteNodeData;
    return (
      <>
        <h2 className="cv-inspector-title">Note</h2>
        <Field label="Title">
          <input
            className="cv-input"
            value={d.title ?? ''}
            onChange={(e) => update(nodeId, { title: e.target.value })}
          />
        </Field>
        <Field label="Link" hint="Opened in the OS browser — http(s) only">
          <input
            className="cv-input cv-mono"
            placeholder="https://…"
            value={d.link ?? ''}
            onChange={(e) => update(nodeId, { link: e.target.value })}
          />
        </Field>
        <Field
          label="Body"
          hint="Supports # headings, - bullets, - [ ] checkboxes, **bold**, `code`, [text](url)"
        >
          <textarea
            className="cv-input cv-mono"
            rows={10}
            value={d.body}
            onChange={(e) => update(nodeId, { body: e.target.value })}
          />
        </Field>
        <div className="cv-row">
          <Field label="Font size">
            <input
              className="cv-input"
              type="number"
              min={9}
              max={40}
              value={d.fontSize}
              onChange={(e) => update(nodeId, { fontSize: Number(e.target.value) })}
            />
          </Field>
          <Field label="Style">
            <select
              className="cv-input"
              value={d.variant}
              onChange={(e) => update(nodeId, { variant: e.target.value as NoteNodeData['variant'] })}
            >
              <option value="plain">Plain note</option>
              <option value="change">Change note</option>
              <option value="sticky">Sticky note</option>
            </select>
          </Field>
        </div>
        <div className="cv-row">
          <Field label="Text">
            <input
              className="cv-color"
              type="color"
              value={d.textColor}
              onChange={(e) => update(nodeId, { textColor: e.target.value })}
            />
          </Field>
          <Field label="Background">
            <input
              className="cv-color"
              type="color"
              value={d.background}
              onChange={(e) => update(nodeId, { background: e.target.value })}
            />
          </Field>
          <Field label="Border">
            <input
              className="cv-color"
              type="color"
              value={d.borderColor}
              onChange={(e) => update(nodeId, { borderColor: e.target.value })}
            />
          </Field>
        </div>
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.locked}
            onChange={(e) => update(nodeId, { locked: e.target.checked })}
          />
          Lock this note
        </label>
      </>
    );
  }

  const d = node.data as DeviceNodeData;
  const auto = deviceColor(d.deviceType, status, ground);
  const setColor = (key: keyof NonNullable<DeviceNodeData['style']>, value: string) =>
    update(nodeId, { style: { ...d.style, [key]: value } });
  const resetColor = (key: keyof NonNullable<DeviceNodeData['style']>) => {
    const next = { ...d.style };
    delete next[key];
    update(nodeId, { style: next });
  };

  return (
    <>
      <h2 className="cv-inspector-title">
        Node
        <span className="cv-status-chip" style={{ background: STATUS_COLOR[status] }}>
          {STATUS_GLYPH[status]} {STATUS_LABEL[status]}
        </span>
      </h2>

      <Field label={d.deviceType === 'text' || d.deviceType === 'callout' ? 'Text' : 'Display name'}>
        {d.deviceType === 'text' || d.deviceType === 'callout' ? (
          // LT-182: a text box or callout keeps its line breaks.
          <textarea
            className="cv-input"
            rows={Math.min(8, Math.max(2, d.label.split('\n').length))}
            value={d.label}
            onChange={(e) => update(nodeId, { label: e.target.value })}
          />
        ) : (
          <input
            className="cv-input"
            value={d.label}
            onChange={(e) => update(nodeId, { label: e.target.value })}
          />
        )}
      </Field>
      <TextStyleFields
        title="Name text"
        value={d.labelStyle}
        allowAlign
        defaultColor={DEFAULTS.labelInk}
        defaultBackground={DEFAULTS.labelBackground}
        onChange={(labelStyle) => update(nodeId, { labelStyle })}
      />
      {/* LT-166: a section can be a logical boundary with an identifier. */}
      {d.deviceType === 'zone' && (
        <div className="cv-row">
          <Field label="Boundary">
            <select
              className="cv-input"
              value={d.boundaryKind ?? ''}
              onChange={(e) =>
                update(nodeId, {
                  boundaryKind: isBoundaryKind(e.target.value) ? e.target.value : undefined,
                })
              }
            >
              <option value="">Plain section</option>
              {BOUNDARY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {BOUNDARIES[k].label}
                </option>
              ))}
            </select>
          </Field>
          {isBoundaryKind(d.boundaryKind) && (
            <Field
              label="Identifier"
              hint={boundaryIdProblem(d.boundaryKind, d.boundaryId) ?? BOUNDARIES[d.boundaryKind].hint}
            >
              <input
                className="cv-input cv-mono"
                value={d.boundaryId ?? ''}
                spellCheck={false}
                aria-invalid={Boolean(boundaryIdProblem(d.boundaryKind, d.boundaryId))}
                onChange={(e) => update(nodeId, { boundaryId: e.target.value })}
              />
            </Field>
          )}
        </div>
      )}
      <div className="cv-row">
        <Field label="Device type">
          <select
            className="cv-input"
            value={d.deviceType}
            onChange={(e) => update(nodeId, { deviceType: e.target.value as DeviceType })}
          >
            {Object.entries(DEVICE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role" hint={d.roleEvidence ? `A crawl decided this: ${d.roleEvidence}` : undefined}>
          <input
            className="cv-input"
            value={d.role ?? ''}
            // A role typed by hand is the operator's; the crawl's reasons no
            // longer describe it (LT-214).
            onChange={(e) => update(nodeId, { role: e.target.value, roleEvidence: undefined })}
          />
        </Field>
      </div>
      <div className="cv-row">
        <Field label="Vendor">
          <input
            className="cv-input"
            value={d.vendor ?? ''}
            onChange={(e) => update(nodeId, { vendor: e.target.value })}
          />
        </Field>
        <Field label="Model">
          <input
            className="cv-input"
            value={d.model ?? ''}
            onChange={(e) => update(nodeId, { model: e.target.value })}
          />
        </Field>
      </div>
      {/* LT-171: what the shape brought with it, all editable. The port names
          are offered when a link's port label is typed. */}
      <div className="cv-row">
        <Field label="Ports">
          <input
            className="cv-input"
            type="number"
            min={0}
            value={d.portCount ?? ''}
            onChange={(e) =>
              update(nodeId, { portCount: e.target.value === '' ? undefined : Math.max(0, Math.floor(Number(e.target.value))) })
            }
          />
        </Field>
        <Field label="Port naming" hint="{n} is the port number">
          <input
            className="cv-input cv-mono"
            value={d.portNaming ?? ''}
            spellCheck={false}
            placeholder="Port {n}"
            onChange={(e) => update(nodeId, { portNaming: e.target.value })}
          />
        </Field>
        <Field label="Rack units" hint="0 for zero-U">
          <input
            className="cv-input"
            type="number"
            min={0}
            value={d.rackUnits ?? ''}
            onChange={(e) =>
              update(nodeId, { rackUnits: e.target.value === '' ? undefined : Math.max(0, Math.floor(Number(e.target.value))) })
            }
          />
        </Field>
      </div>
      <div className="cv-row">
        <Field label="Hostname">
          <input
            className="cv-input"
            value={d.hostname ?? ''}
            onChange={(e) => update(nodeId, { hostname: e.target.value })}
          />
        </Field>
        <Field label="Rack / room">
          <input
            className="cv-input"
            value={d.rack ?? ''}
            onChange={(e) => update(nodeId, { rack: e.target.value })}
          />
        </Field>
      </div>
      {/* The serial is the number an RMA, a support contract and a licence
          are all keyed on, and the one piece of inventory that cannot be
          worked out from anything else on the diagram. A crawl fills it in
          where the device will say it. */}
      <div className="cv-row">
        <Field
          label="Serial number"
          // A stack is one device with several boxes in it, so this is a list.
          // The count is shown rather than assumed: an operator who expects
          // four members and sees three has found something.
          hint={
            serialCount(d.serial) > 1
              ? `${serialCount(d.serial)} chassis — a stack or a pair`
              : 'Several, comma-separated, for a stack'
          }
        >
          <input
            className="cv-input cv-mono"
            value={d.serial ?? ''}
            spellCheck={false}
            placeholder="FOC1932X0AA, FOC1932X0BB"
            onChange={(e) => update(nodeId, { serial: e.target.value })}
          />
        </Field>
        <Field label="Asset tag">
          <input
            className="cv-input cv-mono"
            value={d.assetTag ?? ''}
            spellCheck={false}
            onChange={(e) => update(nodeId, { assetTag: e.target.value })}
          />
        </Field>
      </div>
      {/* LT-146: what discovery proved, in the panel rather than only in the
          results table it came from. Every one of these is filled in by a
          ping sweep or a crawl and every one is still editable — a value
          someone corrects by hand is theirs, and the fields say where the
          machine's version came from. */}
      <div className="cv-row">
        <Field label="MAC address" hint="Read from the ARP table, or from a switch's port">
          <input
            className="cv-input cv-mono"
            value={d.mac ?? ''}
            spellCheck={false}
            placeholder="74:56:3c:00:00:01"
            onChange={(e) => update(nodeId, { mac: e.target.value })}
          />
        </Field>
        <Field label="VLAN" hint="Where a switch reported one">
          <input
            className="cv-input cv-mono"
            value={d.vlan ?? ''}
            spellCheck={false}
            onChange={(e) => update(nodeId, { vlan: e.target.value })}
          />
        </Field>
      </div>
      <div className="cv-row">
        <Field label="Software" hint="What the device said it is running">
          <input
            className="cv-input"
            value={d.osVersion ?? ''}
            onChange={(e) => update(nodeId, { osVersion: e.target.value })}
          />
        </Field>
        <Field label="Connects to" hint="The switch and port it was learned on">
          <input
            className="cv-input cv-mono"
            value={d.switchPort ?? ''}
            spellCheck={false}
            placeholder="LAB-CORE-SW1 Gi1/0/11"
            onChange={(e) => update(nodeId, { switchPort: e.target.value })}
          />
        </Field>
      </div>
      {/* LT-148: a stack is one device on a diagram and several boxes an RMA
          is raised against, so the members are shown with their own serials.
          Only for a device that reported one — which is most of them not. */}
      {(d.stackKind || d.stackMembers) && (
        <div className="cv-row">
          <Field
            label="Stack or chassis pair"
            hint={
              d.stackUnverified
                ? 'Read by a parser that has not yet met this hardware — check it against the device'
                : undefined
            }
          >
            <input
              className="cv-input"
              value={d.stackKind ?? ''}
              onChange={(e) => update(nodeId, { stackKind: e.target.value })}
            />
          </Field>
          <Field label="Members" hint="Number, role and serial, one per line">
            <textarea
              className="cv-input cv-mono"
              rows={Math.min(6, Math.max(2, (d.stackMembers ?? '').split('\n').length))}
              value={d.stackMembers ?? ''}
              spellCheck={false}
              onChange={(e) => update(nodeId, { stackMembers: e.target.value })}
            />
          </Field>
        </div>
      )}
      <div className="cv-row">
        <Field label="Open ports" hint="What answered a connection during the sweep">
          <input
            className="cv-input cv-mono"
            value={d.openPorts ?? ''}
            spellCheck={false}
            placeholder="22/SSH, 443/HTTPS"
            onChange={(e) => update(nodeId, { openPorts: e.target.value })}
          />
        </Field>
        {d.dnsName && (
          <Field label="DNS name" hint="What reverse DNS calls its address">
            <input className="cv-input cv-mono" value={d.dnsName} readOnly />
          </Field>
        )}
        <Field label="Found by" hint="Who said all this">
          <input
            className="cv-input"
            value={d.discoveredVia ?? ''}
            onChange={(e) => update(nodeId, { discoveredVia: e.target.value })}
          />
        </Field>
      </div>
      {/* LT-199: saved credentials a crawl tries on this device first. Ids only. */}
      <div className="cv-row">
        <Field label="Log in with" hint="A saved SSH credential to try on this device before the crawl's own">
          <SavedCredentialSelect kind="ssh" label="Saved SSH credential for this device" value={d.sshCredentialId}
            onChange={(id) => update(nodeId, { sshCredentialId: id })} />
        </Field>
        <Field label="SNMP with" hint="A saved SNMP credential to try on this device first">
          <SavedCredentialSelect kind="snmp" label="Saved SNMP credential for this device" value={d.snmpCredentialId}
            onChange={(id) => update(nodeId, { snmpCredentialId: id })} />
        </Field>
      </div>
      {d.inventory && <InventorySection inventory={d.inventory} />}
      {/* LT-234. */}
      <NeighboursSection nodeId={nodeId} />
      <AttachmentsSection nodeId={nodeId} data={d} />
      {/* LT-239. */}
      <CommentsSection threads={d.comments} onChange={(next, label) => useStore.getState().setComments(nodeId, next, label)} />
      {/* LT-149: commands this device gets on top of the Backups tab's global
          list. Only commands that read are ever run; anything else is refused
          before a connection opens. Deliberately no placeholder — nothing
          ships pre-filled (D-027). */}
      <div className="cv-row">
        <Field label="Show commands" hint="Run for this device only, on top of the global list in Backups — one per line">
          <textarea
            className="cv-input cv-mono"
            rows={3}
            value={d.showCommands ?? ''}
            spellCheck={false}
            onChange={(e) => update(nodeId, { showCommands: e.target.value })}
          />
        </Field>
      </div>
      <div className="cv-row">
        <ColorField label="Icon" value={d.style?.iconColor ?? auto} isSet={!!d.style?.iconColor}
          onChange={(v) => setColor('iconColor', v)} onReset={() => resetColor('iconColor')} />
        <ColorField label="Background" value={d.style?.background ?? auto} isSet={!!d.style?.background}
          onChange={(v) => setColor('background', v)} onReset={() => resetColor('background')} />
        <ColorField label="Border" value={d.style?.border ?? auto} isSet={!!d.style?.border}
          onChange={(v) => setColor('border', v)} onReset={() => resetColor('border')} />
      </div>
      {/* LT-168: this device's glyph, outline or solid, or the page's choice. */}
      <Field label="Glyph">
        <select
          className="cv-input"
          value={d.style?.glyphVariant ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'outline' || v === 'solid') update(nodeId, { style: { ...d.style, glyphVariant: v } });
            else resetColor('glyphVariant');
          }}
        >
          <option value="">As the page draws them</option>
          <option value="outline">Outline</option>
          <option value="solid">Solid tile</option>
        </select>
      </Field>
      <Field label="Tags" hint="Comma separated">
        <input
          className="cv-input"
          value={d.tags.join(', ')}
          onChange={(e) =>
            update(nodeId, {
              tags: e.target.value
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            })
          }
        />
      </Field>
      <Field label="Notes">
        <textarea
          className="cv-input"
          rows={3}
          value={d.notes ?? ''}
          onChange={(e) => update(nodeId, { notes: e.target.value })}
        />
      </Field>
      <Field label="Link" hint="A runbook, a vendor portal, a ticket — opened in the OS browser">
        <input
          className="cv-input cv-mono"
          placeholder="https://…"
          value={d.link ?? ''}
          onChange={(e) => update(nodeId, { link: e.target.value })}
        />
      </Field>

      <div className="cv-checks">
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.showDetails}
            onChange={(e) => update(nodeId, { showDetails: e.target.checked })}
          />
          Show address and status on the canvas
        </label>
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.locked}
            onChange={(e) => update(nodeId, { locked: e.target.checked })}
          />
          Lock position
        </label>
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.maintenance}
            onChange={(e) => update(nodeId, { maintenance: e.target.checked })}
          />
          Maintenance — suppress status
        </label>
        {/* LT-160: an HA pair or cluster discovery cannot see. Discovery never
            writes this, so a re-crawl never unticks it. */}
        <label
          className="cv-check"
          title="Draws the stacked glyph — for a firewall pair, a cluster, or a stack not yet crawled"
        >
          <input
            type="checkbox"
            checked={Boolean(d.ha)}
            onChange={(e) => update(nodeId, { ha: e.target.checked })}
          />
          HA pair or cluster — draw as stacked
        </label>
      </div>

      <LayerPicker
        on={d.layers}
        onChange={(layers) => update(nodeId, { layers })}
      />
      <StatusStrip nodeId={nodeId} />
      <AddressList nodeId={nodeId} />
      <ProbeList objectKind="node" objectId={nodeId} />
    </>
  );
}

function AddressList({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => activePage(s.doc).nodes.find((n) => n.id === nodeId));
  const update = useStore((s) => s.updateNodeData);
  const d = node?.data as DeviceNodeData | undefined;
  if (!d) return null;
  const addresses = d.addresses ?? [];

  const set = (next: DeviceNodeData['addresses']) => update(nodeId, { addresses: next });

  return (
    <section className="cv-section">
      <h3>
        Addresses
        <button
          type="button"
          className="cv-btn cv-btn-small"
          onClick={() =>
            set([
              ...addresses,
              { id: uid(), label: 'Management', address: '', isPrimary: addresses.length === 0 },
            ])
          }
        >
          Add address
        </button>
      </h3>
      {addresses.length === 0 && (
        <p className="cv-help">No addresses yet. Add one, then create a probe that uses it.</p>
      )}
      {addresses.map((a, i) => (
        <div className="cv-addr" key={a.id}>
          <input
            className="cv-input cv-addr-label"
            aria-label="Address label"
            value={a.label}
            placeholder="Label"
            onChange={(e) => {
              const next = [...addresses];
              next[i] = { ...a, label: e.target.value };
              set(next);
            }}
          />
          <input
            className="cv-input cv-mono"
            value={a.address}
            placeholder="10.10.10.1 or fw.example.net"
            aria-label="Address"
            onChange={(e) => {
              const next = [...addresses];
              next[i] = { ...a, address: e.target.value };
              set(next);
            }}
          />
          <button
            type="button"
            className={`cv-btn cv-btn-small ${a.isPrimary ? 'is-active' : ''}`}
            title="Mark as the primary address"
            onClick={() => set(addresses.map((x, j) => ({ ...x, isPrimary: j === i })))}
          >
            Primary
          </button>
          <button
            type="button"
            className="cv-btn cv-btn-small is-danger"
            onClick={() => set(addresses.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}

function ProbeList({ objectKind, objectId }: { objectKind: 'node' | 'link'; objectId: string }) {
  const meta = useStore((s) => s.meta)!;
  // See DeviceNode: filtering inside the selector allocates a new array per
  // read and loops forever under useSyncExternalStore.
  const allProbes = useStore((s) => s.doc.probes);
  const probes = useMemo(
    () => allProbes.filter((p) => p.objectId === objectId),
    [allProbes, objectId],
  );
  const upsert = useStore((s) => s.upsertProbe);
  const remove = useStore((s) => s.removeProbe);
  const templates = useStore((s) => s.doc.probeTemplates) ?? [];

  // Start a new node probe on the address the node already carries. Leaving it
  // blank means "Add probe" produces something that checks nothing, which
  // reads as the app being broken rather than as a field left to fill in.
  const nodes = useStore((s) => activePage(s.doc).nodes);
  const suggestedTarget = useMemo(() => {
    if (objectKind !== 'node') return '';
    const data = nodes.find((n) => n.id === objectId)?.data as DeviceNodeData | undefined;
    const addrs = data?.addresses ?? [];
    return (addrs.find((a) => a.isPrimary) ?? addrs[0])?.address ?? '';
  }, [nodes, objectId, objectKind]);

  return (
    <section className="cv-section">
      <h3>
        Probes
        <button
          type="button"
          className="cv-btn cv-btn-small"
          onClick={() => upsert(newProbe(objectKind, objectId, meta.id, suggestedTarget))}
        >
          Add probe
        </button>
        {objectKind === 'node' && templates.length > 0 && (
          <select
            className="cv-input cv-probe-template-pick"
            aria-label="Add a probe from a template"
            value=""
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              if (t) upsert(probeFromTemplate(t, 'node', objectId, meta.id, suggestedTarget, uid()));
            }}
          >
            <option value="">From a template…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
      </h3>
      {probes.length === 0 && (
        <p className="cv-help">
          No probes configured. Nothing here is checked until you add one and start validation.
        </p>
      )}
      {probes.map((p) => (
        <ProbeEditor key={p.id} probe={p} onChange={upsert} onRemove={() => remove(p.id)} />
      ))}
    </section>
  );
}

function ProbeEditor({
  probe,
  onChange,
  onRemove,
}: {
  probe: Probe;
  onChange: (p: Probe) => void;
  onRemove: () => void;
}) {
  const runtime = useStore((s) => s.runtime.get(probe.id));
  const testNow = useStore((s) => s.testNow);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  // LT-222: the name to save this check under as a template.
  const [templateName, setTemplateName] = useState<string | null>(null);
  const saveTemplate = useStore((s) => s.saveProbeTemplate);

  const patch = (over: Partial<Probe>) => onChange({ ...probe, ...over });

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await testNow(probe);
      setResult(`${r.outcome === 'success' || r.outcome === 'restarted' ? 'OK' : 'Failed'} — ${r.summary}`);
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="cv-probe">
      <div className="cv-probe-head">
        <button type="button" className="cv-probe-toggle" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'}
        </button>
        <input
          className="cv-input cv-probe-name"
          value={probe.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
        {runtime && (
          <span className="cv-status-chip" style={{ background: STATUS_COLOR[runtime.status] }}>
            {STATUS_GLYPH[runtime.status]} {STATUS_LABEL[runtime.status]}
          </span>
        )}
        <button type="button" className="cv-btn cv-btn-small" title="Save these settings to add to other devices"
          onClick={() => setTemplateName(templateName === null ? probe.name : null)}>
          Save as template
        </button>
        <button type="button" className="cv-btn cv-btn-small is-danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      {templateName !== null && (
        <form
          className="cv-row cv-row-tight cv-probe-template-save"
          onSubmit={(e) => {
            e.preventDefault();
            if (!templateName.trim()) return;
            saveTemplate(templateFromProbe(probe, templateName, uid()));
            useStore.getState().setStatusMessage(`Saved ${templateName.trim()} as a template.`);
            setTemplateName(null);
          }}
        >
          <input className="cv-input" aria-label="Template name" value={templateName} autoFocus
            onChange={(e) => setTemplateName(e.target.value)} />
          <button type="submit" className="cv-btn cv-btn-small" disabled={!templateName.trim()}>Save</button>
        </form>
      )}

      {open && (
        <div className="cv-probe-body">
          <ProbeHistory probeId={probe.id} />
          <div className="cv-row">
            <Field label="Type">
              <select
                className="cv-input"
                value={probe.kind}
                onChange={(e) => patch({ kind: e.target.value as ProbeKind })}
              >
                <option value="icmp">ICMP ping</option>
                <option value="tcp">TCP port connect</option>
                <option value="dns">DNS resolution</option>
                <option value="http">HTTP GET</option>
                <option value="https">HTTPS GET</option>
                <option value="udp">UDP service reply</option>
                <option value="snmp">SNMP uptime</option>
                <option value="manual">Manual / disabled</option>
              </select>
            </Field>
            <Field label="Target">
              <input
                className="cv-input cv-mono"
                value={probe.target}
                placeholder="10.10.10.1"
                onChange={(e) => patch({ target: e.target.value })}
              />
            </Field>
            {(probe.kind === 'tcp' || probe.kind === 'http' || probe.kind === 'https' || probe.kind === 'udp') && (
              <Field label="Port">
                <input
                  className="cv-input"
                  type="number"
                  min={1}
                  max={65535}
                  value={probe.tcpPort ?? (probe.kind === 'http' ? 80 : probe.kind === 'udp' ? 53 : 443)}
                  onChange={(e) => patch({ tcpPort: Number(e.target.value) })}
                />
              </Field>
            )}
          </div>

          {(probe.kind === 'http' || probe.kind === 'https') && (
            <div className="cv-row">
              <Field label="Path">
                <input
                  className="cv-input cv-mono"
                  value={probe.httpPath ?? '/'}
                  placeholder="/health"
                  onChange={(e) => patch({ httpPath: e.target.value })}
                />
              </Field>
              {probe.kind === 'https' && (
                <label className="cv-check cv-check-inline">
                  <input
                    type="checkbox"
                    checked={probe.ignoreCertErrors ?? false}
                    onChange={(e) => patch({ ignoreCertErrors: e.target.checked })}
                  />
                  Ignore certificate errors
                </label>
              )}
            </div>
          )}

          {(probe.kind === 'http' || probe.kind === 'https') && (
            <div className="cv-row">
              <Field label="Expected text in response">
                <input
                  className="cv-input cv-mono"
                  value={probe.expectedBody ?? ''}
                  placeholder="Application OK — blank checks the status code only"
                  onChange={(e) => patch({ expectedBody: e.target.value || null })}
                />
              </Field>
            </div>
          )}

          {/* LT-217: what a UDP check sends, so the service has something to answer. */}
          {probe.kind === 'udp' && (
            <div className="cv-row">
              <Field label="Send" hint="A reply proves the service is there. No reply means ignored or filtered — UDP cannot tell which.">
                <select
                  className="cv-input"
                  value={['dns', 'ntp', ''].includes(probe.udpPayload ?? '') ? (probe.udpPayload ?? '') : 'hex'}
                  onChange={(e) => patch({ udpPayload: e.target.value === 'hex' ? '00' : e.target.value || null })}
                >
                  <option value="dns">A DNS query</option>
                  <option value="ntp">An NTP time request</option>
                  <option value="">An empty datagram</option>
                  <option value="hex">Bytes, in hex</option>
                </select>
              </Field>
              {!['dns', 'ntp', ''].includes(probe.udpPayload ?? '') && (
                <Field label="Hex bytes">
                  <input
                    className="cv-input cv-mono"
                    value={probe.udpPayload ?? ''}
                    onChange={(e) => patch({ udpPayload: e.target.value })}
                  />
                </Field>
              )}
            </div>
          )}

          {/* LT-220: uptime over SNMP, with a saved credential by id. */}
          {probe.kind === 'snmp' && (
            <div className="cv-row">
              <Field label="SNMP credential" hint="Reads sysUpTime. A restart since the last check shows as a warning.">
                <SavedCredentialSelect
                  kind="snmp"
                  label="Saved SNMP credential for this check"
                  value={probe.snmpCredentialId ?? undefined}
                  onChange={(id) => patch({ snmpCredentialId: id ?? null })}
                />
              </Field>
            </div>
          )}

          {/* LT-219: ask one server directly rather than this machine's resolver. */}
          {probe.kind === 'dns' && (
            <div className="cv-row">
              <Field label="Ask this server" hint="Blank uses this machine's own resolver">
                <input
                  className="cv-input cv-mono"
                  value={probe.dnsServer ?? ''}
                  placeholder="192.0.2.53"
                  onChange={(e) => patch({ dnsServer: e.target.value || null })}
                />
              </Field>
              {probe.dnsServer && (
                <Field label="Record">
                  <select
                    className="cv-input"
                    value={probe.dnsRecord ?? 'A'}
                    onChange={(e) => patch({ dnsRecord: e.target.value })}
                  >
                    {['A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SOA', 'SRV', 'TXT'].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}

          {probe.kind === 'dns' && (
            <div className="cv-row">
              <Field label="Expected address">
                <input
                  className="cv-input cv-mono"
                  value={probe.expectedAddress ?? ''}
                  placeholder="10.20.30.40 — blank accepts any answer"
                  onChange={(e) => patch({ expectedAddress: e.target.value || null })}
                />
              </Field>
            </div>
          )}

          <div className="cv-row">
            <Field label="Interval (s)">
              <input
                className="cv-input"
                type="number"
                min={1}
                value={probe.intervalSeconds}
                onChange={(e) => patch({ intervalSeconds: Number(e.target.value) })}
              />
            </Field>
            <Field label="Timeout (ms)">
              <input
                className="cv-input"
                type="number"
                min={100}
                step={100}
                value={probe.timeoutMs}
                onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="Warn above (ms)">
              <input
                className="cv-input"
                type="number"
                min={1}
                value={probe.warningLatencyMs ?? ''}
                onChange={(e) =>
                  patch({ warningLatencyMs: e.target.value ? Number(e.target.value) : null })
                }
              />
            </Field>
          </div>

          <div className="cv-row">
            <Field label="Fail after" hint="consecutive failures">
              <input
                className="cv-input"
                type="number"
                min={1}
                value={probe.failureThreshold}
                onChange={(e) => patch({ failureThreshold: Number(e.target.value) })}
              />
            </Field>
            <Field label="Recover after" hint="consecutive successes">
              <input
                className="cv-input"
                type="number"
                min={1}
                value={probe.recoveryThreshold}
                onChange={(e) => patch({ recoveryThreshold: Number(e.target.value) })}
              />
            </Field>
          </div>

          <div className="cv-checks">
            <label className="cv-check">
              <input
                type="checkbox"
                checked={probe.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              Enabled
            </label>
            <label className="cv-check">
              <input
                type="checkbox"
                checked={probe.isPrimary}
                onChange={(e) => patch({ isPrimary: e.target.checked })}
              />
              Primary probe for this object
            </label>
            <label className="cv-check">
              <input
                type="checkbox"
                checked={probe.maintenance}
                onChange={(e) => patch({ maintenance: e.target.checked })}
              />
              Maintenance
            </label>
          </div>

          <div className="cv-probe-actions">
            <button
              type="button"
              className="cv-btn"
              onClick={runTest}
              disabled={testing || !probe.target}
              title="Runs this check once. It does not start ongoing monitoring."
            >
              {testing ? 'Testing…' : 'Test now'}
            </button>
            {result && <span className="cv-probe-result cv-mono">{result}</span>}
          </div>

          {runtime?.lastSummary && (
            <p className="cv-help cv-mono">
              Live: {runtime.lastSummary}
              {runtime.consecutiveFailures > 0 &&
                ` · ${runtime.consecutiveFailures} of ${runtime.failureThreshold} failures`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LinkInspector({ edgeId }: { edgeId: string }) {
  const edge = useStore((s) => activePage(s.doc).edges.find((e) => e.id === edgeId));
  const doc = useStore((s) => s.doc);
  const runtime = useStore((s) => s.runtime);
  const sessionRunning = useStore((s) => s.session.state === 'running');
  const nodeStatusOf = useStore((s) => s.nodeStatus);
  const update = useStore((s) => s.updateEdgeData);

  if (!edge) return null;
  const d = edge.data as LinkData;
  const rule = d.healthRule ?? { type: 'manual' as LinkHealthRuleType };

  const status = linkStatus({
    link: { enabled: d.enabled, maintenance: d.maintenance, healthRule: rule },
    sourceStatus: nodeStatusOf(edge.source),
    targetStatus: nodeStatusOf(edge.target),
    linkProbes: doc.probes.filter((p) => p.objectId === edgeId),
    allProbes: doc.probes,
    runtime,
    sessionRunning,
  });

  const nodeProbes = doc.probes.filter((p) => p.objectKind === 'node');
  const nameOf = (id: string) =>
    (activePage(doc).nodes.find((n) => n.id === id)?.data as DeviceNodeData | undefined)?.label ?? id;
  const portsOf = (id: string) =>
    portNames(activePage(doc).nodes.find((n) => n.id === id)?.data as DeviceNodeData | undefined);
  const sourcePorts = portsOf(edge.source);
  const targetPorts = portsOf(edge.target);

  return (
    <>
      <h2 className="cv-inspector-title">
        Link
        <span className="cv-status-chip" style={{ background: STATUS_COLOR[status] }}>
          {STATUS_GLYPH[status]} {STATUS_LABEL[status]}
        </span>
      </h2>
      <p className="cv-help">
        {nameOf(edge.source)} → {nameOf(edge.target)}
        <br />
        Driven by: {describeRule(rule, [...doc.probes])}
      </p>

      <div className="cv-row">
        <Field label="Source port label" hint="e.g. port3">
          <input
            className="cv-input cv-mono"
            value={d.sourcePortLabel}
            list={sourcePorts.length ? `cv-ports-${edgeId}-s` : undefined}
            onChange={(e) => update(edgeId, { sourcePortLabel: e.target.value })}
          />
        </Field>
        <Field label="Target port label" hint="e.g. Te1/0/48">
          <input
            className="cv-input cv-mono"
            value={d.targetPortLabel}
            list={targetPorts.length ? `cv-ports-${edgeId}-t` : undefined}
            onChange={(e) => update(edgeId, { targetPortLabel: e.target.value })}
          />
        </Field>
      </div>
      {/* LT-171: each end's device port names, offered as the label is typed. */}
      {sourcePorts.length > 0 && (
        <datalist id={`cv-ports-${edgeId}-s`}>
          {sourcePorts.map((name) => <option key={name} value={name} />)}
        </datalist>
      )}
      {targetPorts.length > 0 && (
        <datalist id={`cv-ports-${edgeId}-t`}>
          {targetPorts.map((name) => <option key={name} value={name} />)}
        </datalist>
      )}
      <Field label="Centre label" hint="e.g. 10 Gb LACP — VLANs 10,20,30">
        <input
          className="cv-input"
          value={d.label}
          onChange={(e) => update(edgeId, { label: e.target.value })}
        />
      </Field>
      <TextStyleFields
        title="Label text"
        value={d.labelStyle}
        defaultColor={DEFAULTS.labelInk}
        defaultBackground={DEFAULTS.labelBackground}
        onChange={(labelStyle) => update(edgeId, { labelStyle })}
      />
      <TextStyleFields
        title="Port label text"
        value={d.portLabelStyle}
        defaultColor={DEFAULTS.labelInk}
        defaultBackground={DEFAULTS.labelBackground}
        onChange={(portLabelStyle) => update(edgeId, { portLabelStyle })}
      />

      <div className="cv-row">
        <Field label="Path">
          <select
            className="cv-input"
            value={d.pathType}
            onChange={(e) => update(edgeId, { pathType: e.target.value as LinkData['pathType'] })}
          >
            <option value="smoothstep">Smooth step</option>
            <option value="step">Step</option>
            <option value="bezier">Bezier</option>
            <option value="straight">Straight</option>
            <option value="avoid">Around devices</option>
          </select>
        </Field>
        <Field label="Flow direction">
          <select
            className="cv-input"
            value={d.direction}
            onChange={(e) => update(edgeId, { direction: e.target.value as LinkData['direction'] })}
          >
            <option value="forward">Source → target</option>
            <option value="reverse">Target → source</option>
            <option value="both">Bidirectional</option>
            <option value="none">No direction</option>
          </select>
        </Field>
      </div>
      <Field label="Cable" hint="Shown as a tag on the link and listed in the cable schedule">
        <select
          className="cv-input"
          value={d.cableType ?? ''}
          onChange={(e) => update(edgeId, { cableType: isCableType(e.target.value) ? e.target.value : undefined })}
        >
          <option value="">Not set</option>
          {CABLE_TYPES.map((c) => (
            <option key={c} value={c}>
              {CABLES[c].label} ({CABLES[c].tag})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Cable length" hint="As you would write it — 3 m, 10 ft. Listed in the cable schedule">
        <input
          className="cv-input"
          value={d.cableLength ?? ''}
          onChange={(e) => update(edgeId, { cableLength: e.target.value || undefined })}
        />
      </Field>

      {/* LT-239. */}
      <CommentsSection threads={d.comments} onChange={(next, label) => useStore.getState().setComments(edgeId, next, label)} />

      {/* LT-235: what a crawl read about the port at each end. */}
      <PortView
        source={activePage(doc).nodes.find((n) => n.id === edge.source)?.data as DeviceNodeData | undefined}
        target={activePage(doc).nodes.find((n) => n.id === edge.target)?.data as DeviceNodeData | undefined}
        sourcePort={d.sourcePortLabel ?? ''}
        targetPort={d.targetPortLabel ?? ''}
      />

      <section className="cv-section">
        <h3>Health rule</h3>
        <Field
          label="What determines this link's state"
          hint="This is a rule you choose. Coreview does not trace the physical path."
        >
          <select
            className="cv-input"
            value={rule.type}
            onChange={(e) =>
              update(edgeId, {
                healthRule: { ...rule, type: e.target.value as LinkHealthRuleType },
              })
            }
          >
            {Object.entries(HEALTH_RULE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        {rule.type === 'manual' && (
          <Field label="Manual status">
            <select
              className="cv-input"
              value={rule.manualStatus ?? 'unknown'}
              onChange={(e) =>
                update(edgeId, {
                  healthRule: {
                    ...rule,
                    manualStatus: e.target.value as LinkData['healthRule']['manualStatus'],
                  },
                })
              }
            >
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        )}

        {rule.type === 'named-node-probe' && (
          <Field label="Probe">
            <select
              className="cv-input"
              value={rule.probeId ?? ''}
              onChange={(e) =>
                update(edgeId, { healthRule: { ...rule, probeId: e.target.value } })
              }
            >
              <option value="">Select a probe</option>
              {nodeProbes.map((p) => (
                <option key={p.id} value={p.id}>
                  {nameOf(p.objectId)} — {p.name} ({p.target})
                </option>
              ))}
            </select>
          </Field>
        )}
      </section>

      <div className="cv-checks">
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.enabled}
            onChange={(e) => update(edgeId, { enabled: e.target.checked })}
          />
          Link enabled
        </label>
        <label className="cv-check">
          <input
            type="checkbox"
            checked={d.maintenance}
            onChange={(e) => update(edgeId, { maintenance: e.target.checked })}
          />
          Maintenance — suppress status
        </label>
      </div>

      <Field
        label="What this line is"
        hint={
          d.kind === 'leader'
            ? 'A leader carries no health and is not counted'
            : 'A cable, with health and direction'
        }
      >
        <select
          className="cv-input"
          value={d.kind ?? 'link'}
          onChange={(e) => update(edgeId, { kind: e.target.value as LinkData['kind'] })}
        >
          <option value="link">A link between devices</option>
          <option value="leader">A leader, pointing at something</option>
        </select>
      </Field>

      <div className="cv-row">
        <Field label="Line style" hint="Auto follows health">
          <select
            className="cv-input"
            value={d.lineStyle ?? 'auto'}
            onChange={(e) => update(edgeId, { lineStyle: e.target.value as LinkData['lineStyle'] })}
          >
            <option value="auto">Auto — follows health</option>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dash-dot">Dash-dot</option>
          </select>
        </Field>
        <Field label="Thickness">
          <select
            className="cv-input"
            value={String(d.width ?? 2)}
            onChange={(e) => update(edgeId, { width: Number(e.target.value) })}
          >
            {[1, 1.5, 2, 3, 4, 6].map((w) => (
              <option key={w} value={w}>
                {w}px
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="cv-row">
        <Field label="Start end">
          <select
            className="cv-input"
            value={d.startCap ?? capsFor(d).start}
            onChange={(e) => update(edgeId, { startCap: e.target.value as LinkData['startCap'] })}
          >
            {CAP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Finish end">
          <select
            className="cv-input"
            value={d.endCap ?? capsFor(d).end}
            onChange={(e) => update(edgeId, { endCap: e.target.value as LinkData['endCap'] })}
          >
            {CAP_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="cv-row">
        <Field label="Line colour">
          <select
            className="cv-input"
            value={d.colorMode ?? 'status'}
            onChange={(e) =>
              update(edgeId, { colorMode: e.target.value as LinkData['colorMode'] })
            }
          >
            <option value="status">Follow health</option>
            <option value="fixed">A colour of its own</option>
          </select>
        </Field>
        {d.colorMode === 'fixed' && (
          <Field label="Colour" hint="The dots and arrows still show health">
            <input
              className="cv-color"
              type="color"
              value={d.color || DEFAULTS.accent}
              onChange={(e) => update(edgeId, { color: e.target.value })}
            />
          </Field>
        )}
      </div>

      <div className="cv-checks">
        <label className="cv-check">
          <input
            type="checkbox"
            checked={Boolean(d.pinnedSides)}
            onChange={(e) => update(edgeId, { pinnedSides: e.target.checked })}
          />
          Hold this link to the sides it is on now
        </label>
        <span className="cv-field-hint">
          Links normally swing round to face wherever their devices have been moved. Hold one when
          you have deliberately drawn it the long way round.
        </span>
      </div>

      <LayerPicker on={d.layers as string[] | undefined} onChange={(layers) => update(edgeId, { layers })} />

      <Field label="Notes">
        <textarea
          className="cv-input"
          rows={3}
          value={d.notes ?? ''}
          onChange={(e) => update(edgeId, { notes: e.target.value })}
        />
      </Field>

      {rule.type === 'dedicated-probe' && <ProbeList objectKind="link" objectId={edgeId} />}
    </>
  );
}
