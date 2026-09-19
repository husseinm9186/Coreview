import { describe, expect, it } from 'vitest';

import { interactiveHtml } from './htmlExport';

const page = (name: string, label: string) => ({
  name,
  svg: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g data-node="n1"><text>${label.replace(/</g, '&lt;')}</text></g></svg>`,
  devices: [{ id: 'n1', label, type: 'Router', status: 'Healthy', addresses: ['192.0.2.1'], facts: [['Model', 'ISR4331'], ['Serial', '']] as [string, string][] }],
});

describe('the interactive HTML export (LT-254)', () => {
  const html = interactiveHtml('Lab <core>', 'HQ', [page('Core', 'EDGE-RTR1'), page('Branch', 'BR-RTR1</script><script>alert(1)')], new Date(0));

  it('is one file with every page, its tabs and the device data', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.match(/<svg /g)).toHaveLength(2);
    expect(html).not.toContain('<?xml');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('<title>Lab &lt;core&gt;</title>');
    const json = html.slice(html.indexOf('id="cv-data">') + 13, html.indexOf('</script>', html.indexOf('id="cv-data">')));
    const data = JSON.parse(json);
    expect(data[0].devices[0]).toMatchObject({ label: 'EDGE-RTR1', addresses: ['192.0.2.1'], facts: [['Model', 'ISR4331']] });
    expect(data[1].devices[0].label).toBe('BR-RTR1</script><script>alert(1)');
  });

  it('fetches nothing and runs nothing but its own script', () => {
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).toContain("default-src 'none'");
    // The device name above cannot end the data block early.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });
});
