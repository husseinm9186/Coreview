#!/usr/bin/env node
/**
 * Builds a modern shape library from Tabler Icons (MIT), into a folder you
 * point the icon library at.
 *
 * Coreview draws its own shapes and ships no third-party artwork. This fills
 * a folder of your own with a curated slice of Tabler for equipment and
 * concepts. It fetches **no vendor logos**: those are trademarks, and D-028
 * keeps Coreview from shipping or fetching them. The Simple Icons brand marks
 * this script used to fetch were removed for that reason (LT-162).
 *
 * Curated rather than complete. Tabler has five thousand icons; a palette of
 * that many entries is not a palette. What is here is what turns up on
 * network diagrams.
 *
 * The licences are written next to the icons, because a folder of artwork with
 * no licence beside it is a problem waiting to happen.
 *
 *     node scripts/fetch-modern-shapes.mjs <output-folder>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/fetch-modern-shapes.mjs <output-folder>');
  process.exit(2);
}

const TABLER = 'https://raw.githubusercontent.com/tabler/tabler-icons/main/icons/outline';

/** Equipment and concepts, by the group they belong in on a diagram. */
const shapes = {
  'Network': [
    'router', 'network', 'switch-3', 'access-point', 'antenna-bars-5', 'wifi', 'wifi-off',
    'topology-star-3', 'topology-ring-3', 'topology-bus', 'topology-full-hierarchy',
    'plug-connected', 'world', 'route', 'arrows-split-2', 'binary-tree', 'nfc', 'devices-2',
  ],
  'Security': [
    'shield', 'shield-lock', 'shield-check', 'shield-x', 'shield-bolt', 'wall', 'lock', 'key',
    'certificate', 'eye-off', 'alert-triangle', 'bug', 'virus',
  ],
  'Compute': [
    'server', 'server-2', 'server-bolt', 'cpu', 'stack-2', 'box', 'container',
    'device-desktop', 'device-laptop', 'device-imac', 'terminal-2',
  ],
  'Storage and data': [
    'database', 'database-export', 'disc', 'file-stack', 'archive', 'cloud-data-connection',
  ],
  'Cloud': [
    'cloud', 'cloud-computing', 'cloud-lock', 'cloud-network', 'cloud-up', 'building-broadcast-tower',
  ],
  'Endpoints': [
    'printer', 'device-mobile', 'device-tablet', 'phone', 'headset', 'camera', 'device-tv',
    'device-watch', 'scan', 'battery-charging', 'temperature',
  ],
  'Places and people': [
    'building', 'building-factory-2', 'building-warehouse', 'home', 'map-pin', 'users', 'user',
  ],
  'Monitoring': [
    'activity', 'chart-line', 'gauge', 'clock-hour-4', 'bell', 'report-analytics',
  ],
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const humanise = (s) =>
  s
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s(\d)$/, ' $1');

async function fetchIcon(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes('<svg') ? text : null;
  } catch {
    return null;
  }
}

mkdirSync(outDir, { recursive: true });

const catalogue = [];
const missing = [];

/** Fetched a few at a time: a hundred and fifty at once gets throttled, and
 *  one at a time takes a minute for no reason. */
async function inBatches(jobs, size, run) {
  for (let i = 0; i < jobs.length; i += size) {
    await Promise.all(jobs.slice(i, i + size).map(run));
  }
}

const jobs = [
  ...Object.entries(shapes).flatMap(([category, names]) =>
    names.map((name) => ({ category, name, url: `${TABLER}/${name}.svg` })),
  ),
];

await inBatches(jobs, 12, async (job) => {
  const svg = await fetchIcon(job.url);
  if (!svg) {
    missing.push(job.name);
    return;
  }
  const file = `${slug(job.name)}.svg`;
  writeFileSync(join(outDir, file), svg);
  catalogue.push({ file, name: humanise(job.name), category: job.category });
});

catalogue.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify({ icons: catalogue }, null, 2)}\n`);
writeFileSync(
  join(outDir, 'LICENCES.txt'),
  [
    'Shapes in this folder come from Tabler Icons. They are not part of Coreview;',
    'they are fetched into a folder you point the app at.',
    '',
    'Tabler Icons — MIT licence — https://github.com/tabler/tabler-icons',
    '',
  ].join('\n'),
);

console.log(`${catalogue.length} shapes written to ${outDir}`);
if (missing.length) {
  console.log(`${missing.length} not found upstream and skipped: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}`);
}
console.log(`Point Coreview's icon library at ${outDir}.`);
