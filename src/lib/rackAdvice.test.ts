import { describe, expect, it } from 'vitest';

import { lengthMm, rackAdvice, runMm } from './rackAdvice';
import type { Rackable } from './rack';

const rack = { id: 'r', name: 'R1', units: 42 };
const box = (id: string, u: number, extra: Partial<Rackable> = {}): Rackable => ({ id, label: id.toUpperCase(), rack: 'R1', rackU: u, rackUnits: 1, kind: 'device', deviceType: 'access-switch', ...extra });

describe('what a rack planner should tell you', () => {
  it('reads a cable length in any unit a person writes', () => {
    expect(lengthMm('2 m')).toBe(2000);
    expect(lengthMm('0,5m')).toBe(500);
    expect(lengthMm('50 cm')).toBe(500);
    expect(lengthMm('3 ft')).toBeCloseTo(914.4);
    expect(lengthMm("10'")).toBeCloseTo(3048);
    expect(lengthMm('300mm')).toBe(300);
    expect(lengthMm('long')).toBeNull();
    expect(lengthMm('')).toBeNull();
    expect(runMm(1, 1)).toBe(600);
  });

  it('says a rack is top-heavy when the weight sits above the middle', () => {
    const heavy = [box('ups', 40, { weightKg: 60, rackUnits: 2 }), box('sw', 2, { weightKg: 5 })];
    const advice = rackAdvice(rack, heavy);
    expect(advice.map((a) => a.kind)).toEqual(['top-heavy']);
    expect(advice[0]!.text).toMatch(/60 kg above the middle, 5 kg below/);
    expect(advice[0]!.items).toEqual(['ups']);
    // The same weight at the bottom is fine.
    expect(rackAdvice(rack, [box('ups', 1, { weightKg: 60, rackUnits: 2 }), box('sw', 40, { weightKg: 5 })])).toEqual([]);
  });

  it('counts the open U between boxes in a front-to-back rack, and not otherwise', () => {
    const a = box('a', 10, { airflow: 'front-to-back' });
    const b = box('b', 14, { airflow: 'front-to-back' });
    const advice = rackAdvice(rack, [a, b]);
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({ kind: 'unblanked', severity: 'note' });
    expect(advice[0]!.text).toMatch(/3 open U between the boxes \(U11–U13\)/);
    expect(rackAdvice(rack, [box('a', 10), box('b', 14)])).toEqual([]);
    // Blanked, nothing to say.
    expect(rackAdvice(rack, [a, b, { id: 'bl', label: 'Blank', rack: 'R1', rackU: 11, rackUnits: 3, kind: 'furniture', furniture: 'blank' }])).toEqual([]);
  });

  it('flags a PDU over its outlets or its rating, and a box with both supplies on it', () => {
    const pdu: Rackable = { id: 'p', label: 'PDU-A', rack: 'R1', rackU: 1, rackUnits: 1, kind: 'furniture', furniture: 'pdu', outlets: 2, powerW: 1000 };
    const items = [
      pdu,
      box('s1', 10, { powerW: 800, powerFeeds: [{ pduId: 'p', outlet: 1 }, { pduId: 'p', outlet: 2 }] }),
      box('s2', 11, { powerW: 600, powerFeeds: [{ pduId: 'p', outlet: 3 }] }),
    ];
    const kinds = rackAdvice(rack, items).map((a) => a.kind);
    expect(kinds).toEqual(['pdu-outlets', 'pdu-rating', 'no-redundancy']);
    expect(rackAdvice(rack, items).find((a) => a.kind === 'no-redundancy')!.text).toMatch(/S1: both supplies on PDU-A/);
  });

  it('says when a stack\'s members are apart, and when a cable is too short for its run', () => {
    const items = [box('s1', 10, { portCount: 48 }), box('s2', 20, { portCount: 48 }), box('s3', 21, { portCount: 48 })];
    const stack = { id: 'st', name: 'ACCESS', technology: 'cisco-stackwise-480', topology: 'ring' as const, members: [{ nodeId: 's1', number: 1 }, { nodeId: 's2', number: 2 }, { nodeId: 's3', number: 3 }] };
    const links = [{ id: 'e', source: 's1', target: 's2', sourcePortLabel: 'Gi1/0/1', targetPortLabel: 'Gi1/0/2', cableLength: '0.5 m' }];
    const advice = rackAdvice(rack, items, [stack], links);
    expect(advice.map((a) => a.kind)).toEqual(['stack-apart', 'cable-short']);
    expect(advice[0]!.items).toEqual(['s1', 's2']);
    expect(advice[1]!.text).toMatch(/0\.5 m is short for 10U apart — about 1\.0 m with slack/);
    // A long enough cable, and members together: nothing.
    expect(rackAdvice(rack, [box('s1', 10), box('s2', 11)], [{ ...stack, members: stack.members.slice(0, 2) }], [{ ...links[0]!, cableLength: '1 m' }])).toEqual([]);
  });
});
