import { describe, expect, it } from 'vitest';

import { anchorPoint } from './floatingAnchor';
import { glyphBox } from './glyphExtents';
import { anchorSide, labelledPortAnchor, nearestPort, portAnchor, portCountOf, portFromLabel, portName, portsAlong, sideToward } from './portPoints';

const box = { x: 100, y: 100, w: 96, h: 96 };
const sw = { deviceType: 'core-switch', portCount: 4, portNaming: 'Gi1/0/{n}' };

describe('ports as connection points', () => {
  it('names a port from the pattern, the crawl, or plainly', () => {
    expect(portName(sw, 3)).toBe('Gi1/0/3');
    expect(portName({ deviceType: 'router', portCount: 4, ports: [{ port: 'GigabitEthernet0/0/2' }, { port: 'Vlan1' }] }, 2)).toBe('GigabitEthernet0/0/2');
    expect(portName({ deviceType: 'router', portCount: 4 }, 2)).toBe('port 2');
    expect(portCountOf({ deviceType: 'router' })).toBe(0);
    expect(portCountOf({ deviceType: 'router', portCount: 500 })).toBe(0);
  });

  it('reads the port a label names, only when the device has it', () => {
    expect(portFromLabel(sw, 'Gi1/0/4')).toBe(4);
    expect(portFromLabel(sw, 'gi1/0/2')).toBe(2);
    expect(portFromLabel(sw, 'Gi1/0/5')).toBeNull();
    expect(portFromLabel(sw, 'uplink')).toBeNull();
    // A port-channel is not port 1, and a label in another naming is not a port of this one.
    expect(portFromLabel(sw, 'Po1')).toBeNull();
    expect(portFromLabel(sw, 'Te1/1/1')).toBeNull();
    expect(portFromLabel({ deviceType: 'router' }, 'Gi0/1')).toBeNull();
    // Without a pattern: the crawl's name, else the last run of digits.
    expect(portFromLabel({ deviceType: 'router', portCount: 8, ports: [{ port: 'ether3' }] }, 'ether3')).toBe(3);
    expect(portFromLabel({ deviceType: 'router', portCount: 8 }, 'eth 7')).toBe(7);
  });

  it('lays the ports along the drawing\'s edge facing the other end, port 1 first', () => {
    expect(sideToward(box, sw, { x: 148, y: 900 })).toBe('b');
    expect(sideToward(box, sw, { x: 900, y: 148 })).toBe('r');
    const g = glyphBox(box, sw.deviceType);
    const bottom = portsAlong(box, sw, 'b');
    expect(bottom.map((p) => p.name)).toEqual(['Gi1/0/1', 'Gi1/0/2', 'Gi1/0/3', 'Gi1/0/4']);
    expect(bottom[0]!.at.y).toBeCloseTo(g.y + g.h);
    expect(bottom[0]!.at.x).toBeCloseTo(g.x + g.w / 8);
    expect(bottom[3]!.at.x).toBeCloseTo(g.x + (g.w * 7) / 8);
    const right = portAnchor(box, sw, 'r', 1, 4);
    expect(anchorPoint(box, right).x).toBeCloseTo(g.x + g.w);
  });

  it('knows which edge an anchor is on, by the drawing, not the box', () => {
    // Port 4 of 4 on the bottom edge sits near the box's right side; it is still on the bottom.
    expect(anchorSide(box, sw, portAnchor(box, sw, 'b', 4, 4))).toBe('b');
    expect(anchorSide(box, sw, portAnchor(box, sw, 'r', 1, 4))).toBe('r');
    expect(anchorSide(box, sw, { x: 0.5, y: 0 })).toBe('t');
  });

  it('snaps to the nearest port within reach, and a labelled link lands on its port', () => {
    const g = glyphBox(box, sw.deviceType);
    const near = nearestPort(box, sw, { x: g.x + g.w * 0.6, y: g.y + g.h + 6 }, 12);
    expect(near?.k).toBe(3);
    expect(near?.side).toBe('b');
    expect(nearestPort(box, sw, { x: g.x + g.w * 0.6, y: g.y + g.h + 40 }, 12)).toBeNull();
    const a = labelledPortAnchor(box, sw, 'Gi1/0/2', { x: 148, y: 900 });
    expect(a).not.toBeNull();
    expect(anchorPoint(box, a!).x).toBeCloseTo(g.x + (g.w * 3) / 8);
    expect(labelledPortAnchor(box, sw, 'Po1', { x: 148, y: 900 })).toBeNull();
  });
});
