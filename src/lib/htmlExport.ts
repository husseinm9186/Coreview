/**
 * The project as one interactive HTML file (LT-254).
 *
 * For someone who has neither Coreview nor Visio nor a network connection: a
 * single file that opens in any browser, offline, with every page's drawing,
 * page tabs, drag to pan, wheel or buttons to zoom, a search across every
 * device, and a device's details on a click. Nothing is fetched — no fonts,
 * no scripts, no images from anywhere — so it works on an air-gapped laptop
 * and cannot report that it was opened.
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface HtmlDevice {
  id: string;
  label: string;
  type: string;
  status: string;
  addresses: string[];
  /** Label and value, in the order to show them. Empty values are dropped. */
  facts: [string, string][];
}

export interface HtmlPage {
  name: string;
  /** The page's drawing, rendered with `tagNodes` so devices can be found. */
  svg: string;
  devices: HtmlDevice[];
}

/** JSON that cannot close the script element it sits in. */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const STYLE = `
:root { --ground:#f4f6f8; --panel:#ffffff; --ink:#18212b; --dim:#5b6b7a; --line:#d7dee5; --accent:#0b67c2; --hit:#f5a300; }
@media (prefers-color-scheme: dark) { :root { --ground:#0f141a; --panel:#18202a; --ink:#e6edf3; --dim:#94a3b3; --line:#2a3542; --accent:#5aa9f0; --hit:#ffc53d; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--ground); color: var(--ink); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { display: grid; grid-template-rows: auto auto 1fr; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { margin: 0; font-size: 17px; }
header p { margin: 0; color: var(--dim); font-size: 12px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
button, input { font: inherit; color: inherit; }
button { background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button[aria-selected="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tabs { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; }
.tools { display: flex; gap: 6px; align-items: center; margin-left: auto; }
#search { width: min(260px, 60vw); padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--ground); }
main { position: relative; overflow: hidden; }
.viewport { position: absolute; inset: 0; cursor: grab; touch-action: none; }
.viewport.dragging { cursor: grabbing; }
.stage { transform-origin: 0 0; position: absolute; left: 0; top: 0; }
.stage svg { display: block; }
[data-node] { cursor: pointer; }
[data-node].hit > * { filter: drop-shadow(0 0 6px var(--hit)) drop-shadow(0 0 2px var(--hit)); }
#results { position: absolute; top: 8px; right: 16px; width: min(320px, calc(100% - 32px)); max-height: 50%; overflow: auto; margin: 0; padding: 4px; list-style: none; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.18); }
#results li button { width: 100%; text-align: left; border: 0; display: grid; grid-template-columns: 1fr auto; gap: 8px; }
#results li button span { color: var(--dim); font-size: 12px; }
#details { position: absolute; left: 16px; bottom: 16px; width: min(340px, calc(100% - 32px)); max-height: 60%; overflow: auto; padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.18); }
#details h2 { margin: 0 0 2px; font-size: 16px; }
#details .kind { color: var(--dim); font-size: 12px; margin: 0 0 8px; }
#details dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; }
#details dt { color: var(--dim); }
#details dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
#details .close { float: right; }
[hidden] { display: none !important; }
`;

const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('cv-data').textContent);
  var tabs = document.querySelectorAll('[role=tab]');
  var stages = document.querySelectorAll('.stage');
  var viewport = document.querySelector('.viewport');
  var details = document.getElementById('details');
  var results = document.getElementById('results');
  var search = document.getElementById('search');
  var view = { page: 0, x: 0, y: 0, k: 1 };

  function apply() { stages[view.page].style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')'; }
  function fit() {
    var svg = stages[view.page].querySelector('svg');
    var w = svg.width.baseVal.value || 800, h = svg.height.baseVal.value || 600;
    var r = viewport.getBoundingClientRect();
    view.k = Math.min(r.width / w, r.height / h) * 0.95 || 1;
    view.x = (r.width - w * view.k) / 2; view.y = (r.height - h * view.k) / 2; apply();
  }
  function show(i) {
    view.page = i;
    tabs.forEach(function (t, j) { t.setAttribute('aria-selected', String(i === j)); t.tabIndex = i === j ? 0 : -1; });
    stages.forEach(function (s, j) { s.hidden = i !== j; });
    fit();
  }
  function zoom(f, cx, cy) {
    var r = viewport.getBoundingClientRect();
    if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
    var k = Math.max(0.05, Math.min(20, view.k * f));
    view.x = cx - (cx - view.x) * (k / view.k); view.y = cy - (cy - view.y) * (k / view.k); view.k = k; apply();
  }
  function open(pageIndex, id) {
    var d = data[pageIndex].devices.filter(function (x) { return x.id === id; })[0];
    document.querySelectorAll('[data-node].hit').forEach(function (g) { g.classList.remove('hit'); });
    if (!d) { details.hidden = true; return; }
    var g = stages[pageIndex].querySelector('[data-node="' + CSS.escape(id) + '"]');
    if (g) g.classList.add('hit');
    details.querySelector('h2').textContent = d.label;
    details.querySelector('.kind').textContent = [d.type, d.status].filter(Boolean).join(' · ');
    var dl = details.querySelector('dl'); dl.textContent = '';
    var rows = d.addresses.map(function (a, i) { return [i ? '' : (d.addresses.length > 1 ? 'Addresses' : 'Address'), a]; }).concat(d.facts);
    rows.forEach(function (row) { var dt = document.createElement('dt'); dt.textContent = row[0]; var dd = document.createElement('dd'); dd.textContent = row[1]; dl.appendChild(dt); dl.appendChild(dd); });
    details.hidden = false;
  }

  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { show(i); });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var n = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; tabs[n].focus(); show(n);
    });
  });
  var drag = null;
  viewport.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; viewport.setPointerCapture(e.pointerId); });
  viewport.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) { drag.moved = true; viewport.classList.add('dragging'); }
    view.x = drag.vx + e.clientX - drag.x; view.y = drag.vy + e.clientY - drag.y; apply();
  });
  viewport.addEventListener('pointerup', function (e) {
    var wasDrag = drag && drag.moved; drag = null; viewport.classList.remove('dragging');
    if (wasDrag) return;
    // By each device's box, not by painted pixels: a glyph is mostly outline,
    // and a click in the middle of one has to land on it. The smallest box
    // wins, so a device inside a section is found rather than the section.
    var best = null, area = Infinity;
    stages[view.page].querySelectorAll('[data-node]').forEach(function (g) {
      var r = g.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && r.width * r.height < area) { best = g; area = r.width * r.height; }
    });
    open(view.page, best ? best.getAttribute('data-node') : null);
  });
  viewport.addEventListener('wheel', function (e) { e.preventDefault(); var r = viewport.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  document.getElementById('zoom-in').addEventListener('click', function () { zoom(1.25); });
  document.getElementById('zoom-out').addEventListener('click', function () { zoom(0.8); });
  document.getElementById('fit').addEventListener('click', fit);
  details.querySelector('.close').addEventListener('click', function () { open(view.page, null); });
  window.addEventListener('resize', fit);

  search.addEventListener('input', function () {
    var q = search.value.trim().toLowerCase(); results.textContent = '';
    if (!q) { results.hidden = true; return; }
    var found = [];
    data.forEach(function (p, pi) { p.devices.forEach(function (d) {
      var hay = [d.label].concat(d.addresses, d.facts.map(function (f) { return f[1]; })).join(' ').toLowerCase();
      if (hay.indexOf(q) >= 0) found.push([pi, d]);
    }); });
    found.slice(0, 50).forEach(function (f) {
      var li = document.createElement('li'); var b = document.createElement('button'); b.type = 'button';
      b.textContent = f[1].label; var s = document.createElement('span'); s.textContent = data.length > 1 ? data[f[0]].name : (f[1].addresses[0] || '');
      b.appendChild(s); b.addEventListener('click', function () { show(f[0]); open(f[0], f[1].id); results.hidden = true; });
      li.appendChild(b); results.appendChild(li);
    });
    if (!found.length) { var li = document.createElement('li'); li.textContent = 'Nothing matches.'; li.style.padding = '6px 10px'; results.appendChild(li); }
    results.hidden = false;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { results.hidden = true; open(view.page, null); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); }
  });
  show(0);
})();
`;

export function interactiveHtml(title: string, subtitle: string, pages: HtmlPage[], generatedAt = new Date()): string {
  const stages = pages
    .map((p, i) => `<div class="stage"${i ? ' hidden' : ''} aria-label="${esc(p.name)}">${p.svg.replace(/^<\?xml[^>]*\?>\s*/, '')}</div>`)
    .join('\n');
  const tabs = pages
    .map((p, i) => `<button type="button" role="tab" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(p.name)}</button>`)
    .join('');
  const data = pages.map((p) => ({ name: p.name, devices: p.devices.map((d) => ({ ...d, facts: d.facts.filter(([, v]) => v) })) }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>${esc(title)}</h1><p>${esc(subtitle)}${subtitle ? ' · ' : ''}Exported ${esc(generatedAt.toISOString().slice(0, 16).replace('T', ' '))} UTC from Coreview</p></header>
<nav><div class="tabs" role="tablist" aria-label="Pages">${tabs}</div>
<div class="tools"><input id="search" type="search" placeholder="Find a device or address" aria-label="Find a device or address">
<button type="button" id="zoom-out" aria-label="Zoom out">−</button><button type="button" id="fit">Fit</button><button type="button" id="zoom-in" aria-label="Zoom in">+</button></div></nav>
<main><div class="viewport">${stages}</div>
<ul id="results" hidden></ul>
<section id="details" hidden aria-live="polite"><button type="button" class="close" aria-label="Close">×</button><h2></h2><p class="kind"></p><dl></dl></section></main>
<script type="application/json" id="cv-data">${safeJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
