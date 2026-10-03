/**
 * Stacking technologies and how their cables run (LT-683, D-065): what a
 * stack is called, how many members it takes, which ports each member has
 * for it and where they are, whether the members form a ring, a chain or a
 * pair, what the roles are called, and what the cable is.
 *
 * Every preset is built from the vendor's published guide and says so
 * (`verifiedAgainstHardware: false`, D-026's exception): the Catalyst 9300
 * StackWise architecture paper and Cisco's cabling pictures, Aruba's VSF,
 * Backplane Stacking and VSX guides, and the others' public installation
 * guides. A preset becomes verified when a stack on real hardware has been
 * drawn with it and checked against the cabling.
 */

export type StackTopology = 'ring' | 'chain' | 'pair';

export interface StackPreset {
  id: string;
  vendor: string;
  name: string;
  /** What the guide calls the members' roles, first the one in charge. */
  roles: [string, string, string];
  /** The most members the guide allows. */
  maxMembers: number;
  /** The ports each member gives to the stack, as the guide names them. */
  ports: string[];
  /** Where those ports are, which is the face the cables are drawn on. */
  portsOn: 'front' | 'rear';
  /** Which shapes the guide allows; the first is the recommended one. */
  topologies: StackTopology[];
  /** What the cable is called. */
  cable: string;
  /** For a pair: the links beside the main one, drawn in their own colour. */
  pairLinks?: { name: string; count: number; note: string }[];
  /** A sentence from the guide worth keeping in front of the engineer. */
  note: string;
  source: string;
  verifiedAgainstHardware: false;
}

const ring = (p: Omit<StackPreset, 'topologies' | 'verifiedAgainstHardware' | 'roles'> & { roles?: StackPreset['roles'] }): StackPreset => ({
  roles: ['Active', 'Standby', 'Member'],
  ...p,
  topologies: ['ring', 'chain'],
  verifiedAgainstHardware: false,
});
const pair = (p: Omit<StackPreset, 'topologies' | 'verifiedAgainstHardware' | 'maxMembers'>): StackPreset => ({
  ...p,
  maxMembers: 2,
  topologies: ['pair'],
  verifiedAgainstHardware: false,
});

export const STACK_PRESETS: StackPreset[] = [
  ring({
    id: 'cisco-stackwise-480', vendor: 'Cisco', name: 'StackWise-480 / StackWise-1T (Catalyst 9300, 3850)',
    maxMembers: 8, ports: ['STACK 1', 'STACK 2'], portsOn: 'rear', cable: 'StackWise stack cable (50 cm, 1 m, 3 m)',
    note: 'Two stack ports on the back of each switch; up to eight in a ring. The ring runs at half bandwidth while a cable is missing. Active is the highest priority, then the lowest MAC; Standby is elected two minutes later.',
    source: 'Cisco, Catalyst 9300 StackWise System Architecture white paper (c11-741468)',
  }),
  ring({
    id: 'cisco-stackwise-160', vendor: 'Cisco', name: 'StackWise-160 / -80 (Catalyst 9200)',
    maxMembers: 8, ports: ['STACK 1', 'STACK 2'], portsOn: 'rear', cable: 'StackWise stack cable',
    note: 'Two stack ports on the back; up to eight in a ring, the same cabling pattern as the 9300.',
    source: 'Cisco, Catalyst 9200 Series hardware installation guide',
  }),
  ring({
    id: 'cisco-flexstack-plus', vendor: 'Cisco', name: 'FlexStack-Plus (Catalyst 2960-X / 2960-XR)',
    maxMembers: 8, ports: ['STACK 1', 'STACK 2'], portsOn: 'rear', cable: 'FlexStack cable (0.5 m, 1 m, 3 m)',
    note: 'A stacking module in the rear slot gives two ports; up to eight in a ring.',
    source: 'Cisco, Catalyst 2960-X hardware installation guide',
  }),
  ring({
    id: 'meraki-ms', vendor: 'Cisco Meraki', name: 'Meraki MS stacking',
    maxMembers: 8, ports: ['Stack 1', 'Stack 2'], portsOn: 'rear', cable: 'Meraki stacking cable',
    note: 'Two rear stack ports; up to eight in a ring, with the ring closed from the last back to the first.',
    source: 'Cisco Meraki, MS physical stacking documentation',
  }),
  pair({
    id: 'cisco-stackwise-virtual', vendor: 'Cisco', name: 'StackWise Virtual (Catalyst 9500 / 9600)',
    roles: ['Active', 'Standby', 'Member'], ports: ['SVL'], portsOn: 'front', cable: 'StackWise Virtual link (front-panel 10/25/40/100G ports)',
    pairLinks: [{ name: 'SVL', count: 2, note: 'The StackWise Virtual link, one to eight ports bundled' }, { name: 'DAD', count: 1, note: 'Dual-active detection, a link of its own' }],
    note: 'Two chassis as one; the SVL carries control and data, and a dual-active-detection link tells the pair apart when the SVL is cut.',
    source: 'Cisco, Catalyst 9500 StackWise Virtual configuration guide',
  }),
  pair({
    id: 'cisco-vss', vendor: 'Cisco', name: 'VSS (Catalyst 6500 / 4500-X)',
    roles: ['Active', 'Standby', 'Member'], ports: ['VSL'], portsOn: 'front', cable: 'Virtual switch link (10G ports)',
    pairLinks: [{ name: 'VSL', count: 2, note: 'The virtual switch link, at least two ports' }, { name: 'Dual-active', count: 1, note: 'Enhanced PAgP, fast hello, or BFD on a link of its own' }],
    note: 'Two chassis as one virtual switch; the VSL is an EtherChannel of at least two links.',
    source: 'Cisco, Virtual Switching System configuration guide',
  }),
  ring({
    id: 'aruba-vsf', vendor: 'Aruba (AOS-S)', name: 'VSF (2930F, 5400R)',
    roles: ['Commander', 'Standby', 'Member'], maxMembers: 8, ports: ['VSF link 1', 'VSF link 2'], portsOn: 'front', cable: 'Front-panel 1G or 10G ports (up to eight per link)',
    note: 'A ring is recommended; a chain works. Each VSF link is a bundle of front ports between two members. A 5400R VSF is two members.',
    source: 'Aruba, AOS-S 16.10 management and configuration guide, Virtual Switching Framework',
  }),
  ring({
    id: 'aruba-bps', vendor: 'Aruba (AOS-S)', name: 'Backplane Stacking (2930M, 3810M)',
    roles: ['Commander', 'Standby', 'Member'], maxMembers: 10, ports: ['Stack 1', 'Stack 2'], portsOn: 'rear', cable: 'Aruba stacking cable (0.5 m, 1 m, 3 m)',
    note: 'A rear stacking module; up to ten members in a ring or a chain. The 3810M module (JL084A) has four ports, so a mesh is possible too.',
    source: 'Aruba, 3810 Switch Series installation and getting started guide; Backplane Stacking and VSF best practices',
  }),
  ring({
    id: 'aruba-cx-vsf', vendor: 'Aruba (AOS-CX)', name: 'VSF (CX 6200, 6300)',
    roles: ['Conductor', 'Standby', 'Member'], maxMembers: 10, ports: ['VSF link 1', 'VSF link 2'], portsOn: 'front', cable: 'Front-panel 10/25/50G ports',
    note: 'A ring or a chain of up to ten; the roles are Conductor, Standby and Member.',
    source: 'Aruba, AOS-CX Virtual Switching Framework guide',
  }),
  pair({
    id: 'aruba-vsx', vendor: 'Aruba (AOS-CX)', name: 'VSX (CX 6300, 6400, 8xxx)',
    roles: ['Primary', 'Secondary', 'Member'], ports: ['ISL'], portsOn: 'front', cable: 'Inter-switch link (a LAG of front ports)',
    pairLinks: [{ name: 'ISL', count: 2, note: 'The inter-switch link, a LAG; two links or more' }, { name: 'Keepalive', count: 1, note: 'Direct or routed, and never over the ISL or a VSX LAG' }],
    note: 'Two switches that stay two devices with one data plane; the keepalive decides who keeps the VSX LAGs up when the ISL fails.',
    source: 'Aruba, AOS-CX 10.13 Virtual Switching Extension guide',
  }),
  ring({
    id: 'juniper-vc', vendor: 'Juniper', name: 'Virtual Chassis (EX2300, EX3400, EX4300)',
    roles: ['Master', 'Backup', 'Linecard'], maxMembers: 10, ports: ['VCP 0', 'VCP 1'], portsOn: 'rear', cable: 'Virtual Chassis port cable (or front uplinks set as VCPs)',
    note: 'Dedicated VCPs on the back on most models; a ring of up to ten. The uplink ports can be made VCPs where there are no dedicated ones.',
    source: 'Juniper, Virtual Chassis feature guide for EX Series',
  }),
  ring({
    id: 'hpe-irf', vendor: 'HPE Comware', name: 'IRF',
    roles: ['Master', 'Standby', 'Member'], maxMembers: 9, ports: ['IRF-port 1', 'IRF-port 2'], portsOn: 'front', cable: 'Front-panel 10G ports bound to IRF ports',
    note: 'A ring or a daisy chain; each IRF port binds one or more physical ports.',
    source: 'HPE, Comware IRF configuration guide',
  }),
  ring({
    id: 'huawei-istack', vendor: 'Huawei', name: 'iStack',
    roles: ['Master', 'Standby', 'Slave'], maxMembers: 9, ports: ['Stack port 1', 'Stack port 2'], portsOn: 'rear', cable: 'Stack cable or front service ports',
    note: 'A ring or a chain; dedicated stack cards on some models, service ports on others.',
    source: 'Huawei, CloudEngine and S series stacking configuration guides',
  }),
  ring({
    id: 'extreme-summitstack', vendor: 'Extreme', name: 'SummitStack',
    roles: ['Master', 'Backup', 'Standby'], maxMembers: 8, ports: ['Stack 1', 'Stack 2'], portsOn: 'rear', cable: 'SummitStack cable',
    note: 'A ring of up to eight; a chain is a broken ring.',
    source: 'Extreme, ExtremeXOS SummitStack configuration guide',
  }),
  pair({
    id: 'dell-vlt', vendor: 'Dell', name: 'VLT',
    roles: ['Primary', 'Secondary', 'Member'], ports: ['VLTi'], portsOn: 'front', cable: 'VLT interconnect (a LAG of front ports)',
    pairLinks: [{ name: 'VLTi', count: 2, note: 'The VLT interconnect, two or more ports' }, { name: 'Backup', count: 1, note: 'The backup link over the management or an L3 path' }],
    note: 'Two peers with a VLT interconnect and a backup heartbeat link.',
    source: 'Dell, OS10 Virtual Link Trunking guide',
  }),
  pair({
    id: 'arista-mlag', vendor: 'Arista', name: 'MLAG',
    roles: ['Primary', 'Secondary', 'Member'], ports: ['Peer link'], portsOn: 'front', cable: 'Peer link (a port channel)',
    pairLinks: [{ name: 'Peer link', count: 2, note: 'The MLAG peer link, a port channel of two or more' }],
    note: 'Two peers joined by a peer link; the peer address rides on it.',
    source: 'Arista, EOS user manual, MLAG',
  }),
  pair({
    id: 'nvidia-mlag', vendor: 'NVIDIA / Cumulus / Mellanox', name: 'MLAG',
    roles: ['Primary', 'Secondary', 'Member'], ports: ['Peer link'], portsOn: 'front', cable: 'Peer link (IPL on Onyx, peerlink bond on Cumulus)',
    pairLinks: [{ name: 'Peer link', count: 2, note: 'Two or more ports bonded' }],
    note: 'Two peers with a peer link; on Onyx it is the IPL, on Cumulus the peerlink bond.',
    source: 'NVIDIA, Cumulus Linux and Onyx MLAG guides',
  }),
  pair({
    id: 'fortinet-mclag', vendor: 'Fortinet', name: 'FortiSwitch MCLAG',
    roles: ['Peer 1', 'Peer 2', 'Member'], ports: ['ICL'], portsOn: 'front', cable: 'Inter-chassis link (a trunk)',
    pairLinks: [{ name: 'ICL', count: 2, note: 'The inter-chassis link, a trunk of two or more' }],
    note: 'Two FortiSwitches with an ICL between them, managed by the FortiGate.',
    source: 'Fortinet, FortiSwitch managed-by-FortiGate guide, MCLAG',
  }),
];

export function stackPreset(id: string): StackPreset | undefined {
  return STACK_PRESETS.find((p) => p.id === id);
}

/** LT-683: a stack as the document keeps it. */
export interface Stack {
  id: string;
  name: string;
  /** A preset id, or 'custom'. */
  technology: string;
  topology: StackTopology;
  /** The diagram's devices in member order; number is 1-based. */
  members: { nodeId: string; number: number; role?: string }[];
  notes?: string;
}

/** One cable the elevation draws. Member indexes are 0-based into `members`. */
export interface StackCable {
  from: { member: number; port: string };
  to: { member: number; port: string };
  /** The main stack ring/chain, or one of a pair's named links. */
  kind: 'stack' | string;
}

/**
 * The cables a stack needs, the way the guides draw them: in a ring or a
 * chain, member N's second port goes to member N+1's first port, and a ring
 * closes from the last member's second port back to the first member's first
 * port. A pair draws each of its named links between the two members.
 */
export function stackCables(stack: Pick<Stack, 'topology' | 'members' | 'technology'>, preset: StackPreset | undefined): StackCable[] {
  const n = stack.members.length;
  if (n < 2) return [];
  const ports = preset?.ports.length ? preset.ports : ['Stack 1', 'Stack 2'];
  if (stack.topology === 'pair') {
    const links = preset?.pairLinks?.length ? preset.pairLinks : [{ name: ports[0] ?? 'Link', count: 1, note: '' }];
    const out: StackCable[] = [];
    for (const link of links) {
      for (let i = 0; i < link.count; i++) {
        out.push({ from: { member: 0, port: `${link.name}${link.count > 1 ? ` ${i + 1}` : ''}` }, to: { member: 1, port: `${link.name}${link.count > 1 ? ` ${i + 1}` : ''}` }, kind: link.name });
      }
    }
    return out;
  }
  const out: StackCable[] = [];
  const p1 = ports[0] ?? 'Stack 1';
  const p2 = ports[1] ?? ports[0] ?? 'Stack 2';
  for (let i = 0; i < n - 1; i++) out.push({ from: { member: i, port: p2 }, to: { member: i + 1, port: p1 }, kind: 'stack' });
  if (stack.topology === 'ring') out.push({ from: { member: n - 1, port: p2 }, to: { member: 0, port: p1 }, kind: 'stack' });
  return out;
}

/** Why a stack cannot be as described, or null. */
export function stackProblem(stack: Pick<Stack, 'name' | 'members' | 'topology' | 'technology'>, preset: StackPreset | undefined): string | null {
  if (!stack.name.trim()) return 'A stack needs a name.';
  const ids = stack.members.map((m) => m.nodeId);
  if (new Set(ids).size !== ids.length) return 'A device can be in a stack once.';
  if (preset && stack.members.length > preset.maxMembers) return `${preset.name} takes at most ${preset.maxMembers} members.`;
  if (stack.topology === 'pair' && stack.members.length > 2) return 'A pair is two members.';
  if (preset && !preset.topologies.includes(stack.topology)) return `${preset.name} is ${preset.topologies.join(' or ')}, not ${stack.topology}.`;
  return null;
}

/** The role name for a member, from the preset: the first member is in charge, the second stands by. */
export function roleOf(member: number, preset: StackPreset | undefined, explicit?: string): string {
  if (explicit) return explicit;
  const roles = preset?.roles ?? ['Active', 'Standby', 'Member'];
  return member === 0 ? roles[0] : member === 1 ? roles[1] : roles[2];
}
