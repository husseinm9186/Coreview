import { describe, expect, it } from 'vitest';

import { STACK_PRESETS, roleOf, stackCables, stackPreset, stackProblem } from './stacking';

const members = (n: number) => Array.from({ length: n }, (_, i) => ({ nodeId: `m${i + 1}`, number: i + 1 }));

describe('stack cabling (LT-683)', () => {
  it('runs a StackWise ring the way the Cisco picture does: port 2 to the next port 1, and the last back to the first', () => {
    const preset = stackPreset('cisco-stackwise-480');
    const cables = stackCables({ technology: 'cisco-stackwise-480', topology: 'ring', members: members(4) }, preset);
    expect(cables).toEqual([
      { from: { member: 0, port: 'STACK 2' }, to: { member: 1, port: 'STACK 1' }, kind: 'stack' },
      { from: { member: 1, port: 'STACK 2' }, to: { member: 2, port: 'STACK 1' }, kind: 'stack' },
      { from: { member: 2, port: 'STACK 2' }, to: { member: 3, port: 'STACK 1' }, kind: 'stack' },
      { from: { member: 3, port: 'STACK 2' }, to: { member: 0, port: 'STACK 1' }, kind: 'stack' },
    ]);
  });

  it('draws one cable per neighbouring pair for every ring size from 3 to 8, and one more to close it', () => {
    for (let n = 3; n <= 8; n++) {
      const ring = stackCables({ technology: 'cisco-stackwise-480', topology: 'ring', members: members(n) }, stackPreset('cisco-stackwise-480'));
      const chain = stackCables({ technology: 'cisco-stackwise-480', topology: 'chain', members: members(n) }, stackPreset('cisco-stackwise-480'));
      expect(ring).toHaveLength(n);
      expect(chain).toHaveLength(n - 1);
      expect(ring.at(-1)).toEqual({ from: { member: n - 1, port: 'STACK 2' }, to: { member: 0, port: 'STACK 1' }, kind: 'stack' });
    }
  });

  it('draws a VSX pair as its ISL links and a keepalive of its own', () => {
    const cables = stackCables({ technology: 'aruba-vsx', topology: 'pair', members: members(2) }, stackPreset('aruba-vsx'));
    expect(cables.map((c) => c.kind)).toEqual(['ISL', 'ISL', 'Keepalive']);
    expect(cables.every((c) => c.from.member === 0 && c.to.member === 1)).toBe(true);
  });

  it('draws nothing for one member', () => {
    expect(stackCables({ technology: 'aruba-vsf', topology: 'ring', members: members(1) }, stackPreset('aruba-vsf'))).toEqual([]);
  });

  it('falls back to two generic ports for a custom technology', () => {
    const cables = stackCables({ technology: 'custom', topology: 'chain', members: members(3) }, undefined);
    expect(cables[0]).toEqual({ from: { member: 0, port: 'Stack 2' }, to: { member: 1, port: 'Stack 1' }, kind: 'stack' });
  });
});

describe('stack presets (D-065)', () => {
  it('every preset says it is from the guide and not yet checked on hardware', () => {
    for (const p of STACK_PRESETS) {
      expect(p.verifiedAgainstHardware).toBe(false);
      expect(p.source.length).toBeGreaterThan(10);
      expect(p.topologies.length).toBeGreaterThan(0);
      expect(p.maxMembers).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the numbers the guides give', () => {
    expect(stackPreset('cisco-stackwise-480')?.maxMembers).toBe(8);
    expect(stackPreset('cisco-stackwise-480')?.ports).toEqual(['STACK 1', 'STACK 2']);
    expect(stackPreset('cisco-stackwise-480')?.portsOn).toBe('rear');
    expect(stackPreset('aruba-vsf')?.maxMembers).toBe(8);
    expect(stackPreset('aruba-vsf')?.roles[0]).toBe('Commander');
    expect(stackPreset('aruba-bps')?.maxMembers).toBe(10);
    expect(stackPreset('aruba-vsx')?.maxMembers).toBe(2);
    expect(stackPreset('aruba-vsx')?.roles).toEqual(['Primary', 'Secondary', 'Member']);
  });

  it('names the roles from the preset: the first member leads, the second stands by', () => {
    expect(roleOf(0, stackPreset('aruba-vsf'))).toBe('Commander');
    expect(roleOf(1, stackPreset('aruba-vsf'))).toBe('Standby');
    expect(roleOf(4, stackPreset('aruba-vsf'))).toBe('Member');
    expect(roleOf(0, undefined, 'Boss')).toBe('Boss');
  });
});

describe('stack problems', () => {
  it('refuses more members than the guide allows, a device twice, a pair of three, and a shape the technology does not take', () => {
    expect(stackProblem({ name: 'S', technology: 'aruba-vsx', topology: 'pair', members: members(3) }, stackPreset('aruba-vsx'))).toMatch(/at most 2|two members/);
    expect(stackProblem({ name: 'S', technology: 'cisco-stackwise-480', topology: 'ring', members: members(9) }, stackPreset('cisco-stackwise-480'))).toMatch(/at most 8/);
    expect(stackProblem({ name: 'S', technology: 'cisco-stackwise-480', topology: 'ring', members: [{ nodeId: 'a', number: 1 }, { nodeId: 'a', number: 2 }] }, stackPreset('cisco-stackwise-480'))).toMatch(/once/);
    expect(stackProblem({ name: 'S', technology: 'cisco-stackwise-480', topology: 'pair', members: members(2) }, stackPreset('cisco-stackwise-480'))).toMatch(/ring or chain/);
    expect(stackProblem({ name: '', technology: 'custom', topology: 'ring', members: members(2) }, undefined)).toMatch(/name/);
    expect(stackProblem({ name: 'S', technology: 'cisco-stackwise-480', topology: 'ring', members: members(4) }, stackPreset('cisco-stackwise-480'))).toBeNull();
  });
});
