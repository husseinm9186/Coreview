# User guide

## Create a project

Open Coreview and choose **Create project**. Fill in the name, and — because
these end up in the exported report — the customer, site, change ticket and
engineer. You can edit all of it later: click empty canvas and the inspector
shows project fields.

To see the app working immediately, pick one of the three samples instead. They
use documentation address ranges plus loopback, so one node comes up healthy and
the rest go down. That is the point: you get both states without touching a live
network.

## Draw

Drag anything from the left palette on to the canvas. Drop it, then click it and
rename it in the inspector.

The shapes are Coreview's own and describe what a device *is* — router, L3 or L2
switch, firewall, load balancer, WAF, patch panel, PDU, UPS and so on — not whose
it is. Type the vendor and model into the inspector; the shape stays the same.

A dropped device brings generic defaults for its class: a number of ports and how
they are named (`{n}` is the port number), its height in rack units, and an empty
**Management** address to fill in. Change any of them in the inspector. When you
label a link's ports, the port names of the device at each end are offered as
you type.

Devices are drawn as outlines. Right-click the canvas and choose **Draw devices
as solid tiles** to draw the page's devices filled with their colour instead, the
glyph in whichever ink reads on it; a device's own **Glyph** setting in the
inspector overrides the page either way. Exports match.

**Logical boundaries** — VLAN, subnet, security zone, VRF, BGP AS and OSPF area —
are sections that know what kind of area they are. Drop one, give it its
identifier in the inspector (a VLAN ID, a prefix, a zone or VRF name, an AS
number, an area), and it shows a chip such as `VLAN 20` or `AS 64500` with a dash
pattern of its own. A device inside it moves with it, as with any section. An
identifier that cannot be right — VLAN 5000, a prefix without its length — is
underlined and the inspector says why.

- **Resize** — select an object and drag a corner handle.
- **Connect** — hover a node, drag from one of the four dots to another node.
- **Multi-select** — drag on empty canvas, or Shift-click.
- **Lasso** — hold `Alt` and drag a freehand outline on empty canvas; what it goes
  round (by its middle) is selected. `Alt+Shift` adds to the selection.
- **Grid snap** — the **Grid snap on/off** button in the toolbar (or
  `Ctrl+Shift+G`) makes a dragged object land on the grid, unless it is lining up
  with a neighbour: the alignment guides always win. Holding `Alt` while dragging
  does the opposite of the setting for that drag. Saved with the project; off to
  begin with.
- **Stacking** — `Ctrl+]` / `Ctrl+[` bring forward or send backward a step,
  `Ctrl+Shift+]` / `Ctrl+Shift+[` to the front or back; also on the right-click
  menu. A selection moves as a block.
- **Pan** — middle-drag or right-drag. **Zoom** — scroll.
- **Right-click** anything for its menu.

Shortcuts: `Ctrl+S` save, `Ctrl+Z` undo, `Ctrl+Y` redo, `Ctrl+D` duplicate,
`Delete` remove, `F` fit view, `Shift+F` zoom to the selection, `Ctrl+F` find a
device, `?` every shortcut.

**Zoomed far out on a large diagram** (below 40%, on a page of 500 or more
objects), device names, status lines and badges, connection handles and link
labels are not drawn: they are too small to read, and leaving
them out keeps a large diagram moving. Devices can still be dragged; zoom in to
connect, read or click a link.

**Undo** goes back two hundred steps, and the steps are still there after you
close and reopen the project — unless the project was changed somewhere else in
between. They are kept on this computer only, never in the project file or an
export.

**Text boxes.** Double-click empty canvas to write text there. A text box (or a
callout) keeps its line breaks: `Shift+Enter` starts a new line, `Enter` finishes.

**Label text.** Open **Name text** under a device's name, or **Label text** and
**Port label text** under a link's labels, to set bold, italic, size, colour and background; a device's
name can also be aligned left, centre or right. Exports match the canvas.

**Automatic layouts.** Right-click the canvas: **Arrange top to bottom** tiers
devices by what they are; **Lay out radially** puts the device fewest links from
everything — usually the core — in the middle with the rest in rings;
**Lay out as a mesh** lets links pull and devices push; **Lay out on a grid** puts
each device's hosts in a block under it, for an MDF or IDF drawing. With two or
more devices selected, only the selection is laid out. Locked devices stay put,
and one undo puts everything back.

**Saved views.** Right-click the canvas and choose **Save this view** to remember
where you are and how far in, as *View 1*, *View 2* and so on for that page.
`Alt+1` to `Alt+9` go back to them, as does the canvas menu, which can also forget
one.

**Presenting.** `F5` (or **Present** in the canvas menu) hides the toolbar, panels
and page tabs and shows the diagram alone, full screen where the window allows.
The arrow keys and `Page Up`/`Page Down` move between pages, `F` fits the page,
and `Esc` comes back. Nothing can be edited while presenting.

**Templates.** **Create project** → **Start from** begins with a drawing instead
of a blank page: a branch office, a spine-leaf fabric, a three-tier campus, a DMZ,
SD-WAN, MPLS L3VPN, a wireless survey or two racks. Names and addresses are
placeholders from the documentation ranges, and nothing is monitored until you
add checks.

**Racks.** The **Racks** tab in the bottom panel draws the project's racks U by U.
Give devices a rack name in the inspector (**Rack / room**) and click **Build racks
from devices**, or **Add rack** and drag devices in from the list. A box always
lands on a whole U; a spot something else holds is refused and the message says
what is there. Click a box to move it a U at a time with `↑`/`↓`, mount it on the
rear, make it half depth (a patch panel, so something else can use the same U on
the other face) or take it out. **Front** and **Rear** switch faces; a full-depth
box shows hatched from behind. **Export … as SVG** saves the elevations. Nothing
on the diagram moves.

**Cable schedule.** Set a link's **Cable** and **Cable length** in the inspector.
**Export → Cable schedule as CSV** lists every cable — both ends' devices and
ports, type, length and label — and the validation report includes it.

**Views.** The **Views** section of the palette lists the ways this page is drawn
— a new project starts with *Physical*, *Logical*, *Overlay* and *Annotations*.
Put an object on one from the inspector's **Appears on**; an object on none is on
all of them. Per view: ◉ shows or hides it, 🔒 locks it so nothing on it can be
moved or edited, and ⎙ chooses whether it goes into exports and printing — turn
it off for working notes that should stay on screen but not leave the machine
with the diagram.

**Copy and paste.** `Ctrl+C` and `Ctrl+V` copy the selection and paste it a
little down and to the right. `Ctrl+Shift+V` (**Paste in place** in the canvas
menu) pastes it exactly where it was copied from — on another page too, to put
the same block in the same place there.

**Pages.** Each tab along the bottom is a separate drawing. `Ctrl+Page Down` and
`Ctrl+Page Up` step through them. The **☰** button at the start of the tabs lists
every page with a small sketch of what is on it: click a page or use the arrow
keys to open it, double-click or press `F2` to rename it, and drag it or press
`Alt+↑`/`Alt+↓` to move it.

**Minimap by health.** **Colour the minimap by health** in the canvas menu colours
each device in the minimap by its status; a device that is down is also outlined
dashed and a warning one outlined solid, so the colour is not the only cue.

Autosave writes about two and a half seconds after you stop editing. The top bar
says either *Unsaved changes* or *Saved* with a time.

## Use your own stencils

Coreview ships no vendor icons (see `docs/BRAND_AND_LICENSING.md`). To use artwork
you have the right to use — a vendor pack, your team's own kit — put it in a
folder of your own and point the icon library at it. SVG files load directly;
Visio stencils and EMF files are converted where the converters are installed.

**You are responsible for the licensing of anything you import.** Coreview does
not ship, fetch or update vendor packs.

To have each shape arrive as a proper device rather than a bare picture, put a
`coreview-stencils.json` beside the files:

```json
{
  "coreviewStencils": 1,
  "name": "Lab shapes",
  "licence": "Drawn by the lab team; free to use internally",
  "source": "optional: where the artwork came from",
  "shapes": [
    { "file": "edge-router.svg", "name": "Edge router", "category": "Routing",
      "class": "router", "vendor": "Example Networks", "model": "ER-8",
      "ports": 8, "portNaming": "ge-0/0/{n}", "rackUnits": 1 }
  ]
}
```

- `licence` is required: say under what terms the artwork is used.
- `file` is a file name in the same folder — no paths.
- `class` is one of Coreview's device classes — `router`, `l3-switch`,
  `l2-switch`, `firewall`, `load-balancer`, `waf`, `server`, `vm-host`,
  `storage`, `patch-panel`, `pdu`, `ups` and the rest of the palette. The device
  takes that class's defaults, then the manifest's own values.
- `portNaming` must contain `{n}`; `ports` is at most 1024, `rackUnits` at most 60.
- Every field other than `file` is optional, and an unknown field is refused.

A manifest with a mistake is refused as a whole and the icon library says why,
naming the shape and the field; the shapes still load, undescribed.

When a project uses imported stencils, the **Export** menu says how many devices
use them and which licences they came with, and each saved diagram or package
says so again. Tick **Vendor-safe export** to replace them with Coreview's
built-in shape for each device's class in the diagram files and the project
package — use it for anything shared outside your organisation. Vendor, model
and every other field stay; only the artwork goes. Printing shows the canvas as
it is.

## Label a link

Select a link. The inspector gives you three separate fields:

- **Source port label** — the interface at the near end, e.g. `port3 / Po10`
- **Centre label** — what the link is, e.g. `10 Gb LACP — VLANs 10,20,30`
- **Target port label** — the interface at the far end, e.g. `Te1/0/48 / Po10`

Below that: path type, flow direction, width, notes and the health rule. The
**Around devices** path type draws the link in horizontal and vertical runs that
go round any device in the way, with rounded corners, on the canvas and in
exports; if an end is walled in with no way through, it falls back to a step.

**Cable** says what the link is made of — copper, single-mode or multimode fibre,
coax, wireless, a WAN link or a trunk. It shows as a short tag at the front of the
link's centre label (`SMF · 10G uplink`), on the canvas and in exports, and does
not change the line itself: the line's style is kept for status.

Where two links cross, one hops over the other so you can tell which cable goes
where — whatever path type either uses (smooth step, step, straight or bezier),
on the canvas and in exports alike.

Every shape has **connection points** — a quarter, halfway and three quarters
along each side, and its centre. Drag a selected link's end near one and a ring
shows where it will land; let go and the end is fixed there, on the same device
or a different one. Away from the points, the end slides freely round the
outline.

To move a link to a different device, select it and drag either end handle onto
that device. The moved end's port label is cleared, because it named a port on
the old device; the other end keeps its own. Undo puts it back.

## Add addresses and probes

Select a node. Under **Addresses**, add one row per address with a friendly
label — `Management`, `Loopback0`, `WAN1`. Mark one primary.

Under **Probes**, click **Add probe** and set:

| Field | What it does |
| --- | --- |
| Type | ICMP ping, TCP port connect, DNS resolution, or manual |
| Target | IPv4, IPv6 or a hostname. Internal single-label names are fine. |
| Port | TCP only |
| Interval | Seconds between checks. Default 5. |
| Timeout | Milliseconds to wait. Default 1000. |
| Warn above | RTT in milliseconds that turns a passing check amber. Default 100. |
| Fail after | Consecutive failures before the object goes red. Default 3. |
| Recover after | Consecutive successes needed to leave red. Default 1. |

Press **Test now** to run that check once. It runs once and stops. It does not
start monitoring.

## Choose what each link means

This is the part worth being deliberate about. Select a link and pick a health
rule:

| Rule | Use it when |
| --- | --- |
| Manual — no monitoring | The line is documentation, not a check |
| Follow source node status | The near device is what you actually care about |
| Follow target node status | The far device is |
| Both endpoints must be healthy | You want the line red if either end drops |
| Dedicated probe target | The link has its own address to test — a transit IP, a far-side loopback |
| Follow a named probe on a node | A specific probe elsewhere is the real signal |

The inspector shows the rule in plain language, and so does the tooltip when you
hover a link.

## Start and stop validation

**Start validation** in the top bar begins checking every enabled probe in the
open project. The state pill shows *Running* and the counts fill in.

**Stop validation** ends it. So does closing the project, and so does closing
the window. Nothing survives in the background.

While a session runs, statuses are live. When it stops, everything returns to
unknown — a status from a stopped session is not evidence.

## Read the canvas

| State | Node | Link | Motion |
| --- | --- | --- | --- |
| Healthy `✓` | Green badge | Green line | Green dots moving |
| Warning `!` | Amber badge | Amber line | Slower amber dots |
| Down `✕` | Red badge | Red dashed line | Stopped, one static dot |
| Unknown `?` | Grey | Grey line | None |
| Disabled `–` | Muted | Dotted | None |
| Maintenance `⚙` | Purple | Purple dashed | None |

Every state has a glyph as well as a colour, so nothing depends on colour alone.
Turn on **Reduce motion** in the top bar to stop all animation.

Hover a link for the detail:

```
Health: Healthy
Rule: Dedicated ICMP probe
Target: 10.50.10.1
Last result: Reply, 2 ms
Last updated: 19:11:22
```

## What this proves, and what it does not

Every check runs from the Windows machine Coreview is on. A green node means
that machine reached that address with that method just now. It does not mean
every hop drawn between them is healthy, and it does not mean application
traffic works. Link colour follows the rule you chose. Keep that in mind before
pasting a screenshot into a change record.

## Find what is on the network

Two tools, and they build one diagram between them.

**Ping sweep** walks a subnet and reports what answered. For each host it asks
what it can without credentials: a name — reverse DNS first, then LLMNR,
NetBIOS and mDNS, because a lab subnet usually has no PTR records — the MAC
address out of this machine's own ARP table, the manufacturer behind that MAC,
and which of eighteen common TCP ports are open. Both halves are switchable:
**Identify** turns the name and MAC lookups off, **Ports** the port scan,
which is the noisiest thing the app does.

A switch or firewall usually answers none of those name lookups, but its web
interface presents a certificate, and that often says what the device is.
When the port scan finds HTTPS open (443 or 8443), the sweep reads the
certificate. It never logs in and never trusts the certificate; it only reads
what the certificate says:

- **Name:** used only when nothing else named the host. Hover it and it says
  it came from the certificate.
- **Serial:** Cisco puts the chassis serial in the certificate, and Fortinet
  uses the serial as the certificate's name. A serial is never shown as a
  hostname, and it goes onto the device when you add it to the diagram.
- **Product:** such as *Fortinet FortiSwitch*, shown in the *Model* column
  when the crawl hasn't already filled it in.

This works on both new and old equipment, including switches that only speak
TLS 1.0. It needs **Ports** turned on, because the sweep only reads a
certificate from hosts it knows are serving HTTPS.

For hosts serving plain HTTP (port 80 or 8080), the sweep also reads which
web server answered, such as `cisco-IOS` or `Microsoft-IIS/10.0`, and the
page title unless it's a server's default page. Hover the **80** or **8080**
port in the results to see it. This is the software behind the page, not the
device's name, so it never appears in the *Name* or *Model* columns.

### MAC addresses behind a router

A sweep reads MAC addresses from this computer's own ARP table, which only
holds hosts on your own segment. For a subnet you reach through a router, the
*MAC address* and *Manufacturer* columns stay empty. That's the correct
answer, not a fault.

The router knows those MACs, so after a sweep you can ask it. Under **MAC
addresses behind a router** above the results:

1. Pick an **SNMP credential**. Only credentials saved in the vault are
   offered, and the vault must be unlocked.
2. Check the **Gateway**. It starts as the first address of the subnet you
   swept, which is where most networks put the router; change it if yours is
   elsewhere.
3. Choose **Read gateway's ARP table**.

Hosts that had no MAC get the gateway's, with the manufacturer looked up
from it. Hover the MAC to see which gateway it came from. A MAC the sweep
already had is never replaced, and nothing happens unless you pick a
credential and press the button. The sweep itself never uses credentials.

This uses the same SNMP credentials as discovery, v2c or v3, and reads the
standard ARP table that routers and firewalls publish over SNMP.

A sweep only sees hosts on this segment for MAC purposes — ARP does not cross
a router — so a routed sweep shows a dash rather than the gateway's address.
That is the correct answer, not a gap.

**Discover devices** logs into switches and routers and reads what they know:
CDP and LLDP neighbours, MAC address tables, port channels, whether the box is
a stack or a chassis pair, and where it sends traffic it has no other route
for. It walks into infrastructure only by default — router, switch, firewall,
wireless controller — so an access point or a workstation is drawn from what
its neighbour said rather than logged into.

A device discovery can't log into but can reach over **SNMP** isn't just a
box. It brings its **LLDP neighbours**, so its cables are drawn from its own
side, and the **MAC addresses learned on its ports**, with the maker of each
and an address where the device knows one. Those neighbours are followed like
any other device's. A few limits come from the devices themselves:

- A Cisco switch's MAC table over SNMP covers **VLAN 1 only**. Over SSH it
  reads every VLAN.
- A FortiSwitch's SNMP MAC table isn't in the standard format, so it gives
  neighbours but no attached hosts over SNMP.
- A switch that advertises no LLDP, such as a UniFi, can't have its uplink
  told apart from an access port. Tick **single port only** when choosing
  attached devices to leave out crowded ports like that.

A host two switches both learned is drawn once, on the switch nearest where
the crawl started.

It also visits each device's **default gateway**, even when no switch lists
it as a neighbour. A firewall at the edge usually doesn't speak CDP or LLDP,
so without this the device at the top of the diagram would be the one never
tried. The gateway is tried like everything else: SSH first, then each SNMP
credential in turn. It is skipped if it falls outside the subnets you
allowed, is in an excluded subnet, or is beyond the hop limit.

**They meet.** A device found both ways is one device: the sweep records the
MAC it read, the crawl matches the MAC a switch learned on a port, and the
host moves onto that port with the cable drawn. Running either again updates
the diagram rather than drawing a second copy beside it.

**A sweep reads what the crawl already drew.** Every row in the sweep's
results is looked up on the diagram, on every page, by MAC, then address,
then name:

- **Name**: a host the network would not name shows the name the diagram
  has for it. Hover it to see that it came from the diagram and how the
  device was found, such as *found by SSH login*. When the network did name
  it and the diagram calls it something else, you see both:
  `LabDesktop01 · on diagram as DESK-PC-1`.
- **Model** and **Switch port**: from the crawl. Hover the model for the
  serial and software version.
- A host nothing has drawn shows dashes, not guesses.

Adding a host the crawl already drew doesn't redraw it or rewrite its record.
The sweep adds the ports it found open and fills in a MAC, manufacturer or
name only where the device has none. It never replaces the device's own
name, or *SSH login* with *Ping sweep*.

### What lands on the device

Everything discovery proves is written onto the device itself, so opening one
shows what is known without anyone typing it: its manufacturer and MAC from
the sweep, its model, serial and software from the crawl, the VLAN and the
switch port it hangs off from the switch that sees it, and the ports it
answers on. A stack's members each keep their own serial, which is what an
RMA is keyed on.

Every one of those fields stays editable. A value you correct by hand is
yours — re-running discovery updates what it can prove and leaves the rest
alone.

**Export → Devices and links as CSV** writes all of it, one row per device and
a column per fact, which is the file to read when profiling an estate rather
than redrawing it. A device nothing is known about still gets a row.

### Arranging what was found

**Arrange top to bottom** lays the page out the way an engineer draws one: the
way out at the top, then the edge, the core, the distribution and access
layers, and the things plugged into them at the bottom.

It decides the order from evidence rather than from what each box looks like.
Where a crawl read a device's default route, that device sits *below* whatever
it forwards through — the device's own statement about where its traffic goes
outranks any guess from its icon. Where a switch reported a MAC on a port, the
thing on that port sits below the switch. Only what neither of those covers
falls back to the icon.

It rearranges rather than tidies, so it is on a menu rather than automatic,
and one undo puts the whole page back. A locked device is never moved.

### Stacks and chassis pairs

A stack is one device on a diagram and several boxes an RMA is raised against,
so each member keeps its own serial. A crawled device that reports one shows
which technology holds it together — StackWise, VSF, VSX, Virtual Chassis —
and lists its members with their numbers, roles and serials. It is drawn with
the **stacked glyph** — its symbol doubled, one box behind the other.

Discovery cannot see every pair, so the device inspector has an **HA pair or
cluster** checkbox. Tick it on a firewall pair, a cluster or a stack not yet
crawled and that device draws stacked too. A re-crawl never unticks it.

A **chassis pair** is different from a stack and is drawn differently. VSX,
StackWise Virtual and VSS are two switches sharing an inter-switch link, and
the whole reason they exist is that either half can fail — so they are drawn
as two devices with that link between them, never collapsed into one box —
each half keeps the single glyph.

These readings are marked **unverified** until the parser behind them has met
that kind of hardware: they were written from vendor documentation, and the
panel says so rather than presenting a guess as a fact. Check one against the
device and tell us, and the flag comes off.

### Credentials

SSH and SNMP credentials can be saved in the encrypted vault and picked by
name, or typed for one run. **Several SNMP credentials can be listed, v2c and
v3 mixed** — each is tried in turn until one answers, which is what a mixed
estate needs.

How a scan was set up is remembered between sessions: the subnets, the seed,
the port, the hop limit, which credentials were chosen. **No password is ever
remembered outside the vault.** The settings store is plain text beside your
projects, so it holds the shape of a scan and never its secrets.

**Open the vault by itself.** Once it is unlocked, tick **Open by itself on this
computer** to keep the vault's key in the system keychain (Credential Manager,
Keychain, or the Secret Service on Linux). The passphrase is never kept. Anyone
who can sign in to this account can then use the saved credentials, so leave it
off on a shared machine. Untick it to need the passphrase again.

**Where credentials were used.** **Where they were used**, under the saved
credentials, lists every time one was offered to a device — for a crawl, a
backup, an SNMP check, a ping from a device — with when and how often. It is kept
on this machine only, and can be cleared.

**Starting too often.** A crawl, sweep, backup or validation started many times
within a minute is refused with how long to wait. A person never meets this; it
stops a fault from scanning a network in a loop.

## Run a crawl the way your estate needs

**Seeds.** **Seed devices** takes several at once: addresses, hostnames, or ranges
up to a /20, separated by commas. A range is first narrowed to the addresses that
accept a connection on the login port. **From CSV…** adds the address column of
a spreadsheet.

**How it runs.** **At once** sets how many devices are worked on together,
**Give up after** how long one device may take, and **Retries** how often a device
that did not answer is tried again — a refused login is never retried. **Stop**
stops at once. **Devices this run** shows every device live: queued, probing,
authenticating, waiting for a push approval, collecting, done, or failed and why.

**What is read.** **Also read from each device** chooses ports and VLANs, spanning
tree and the routing table, and whether to look up names in reverse DNS. What was
read appears in the device's inspector under **From the last crawl**.

**Which login where.** In a device's inspector, **Log in with** and **SNMP with**
pick saved credentials to try on that device first. **Saved credentials by subnet
or vendor** in the crawl panel does the same for a subnet or for every device a
neighbour reports as, say, a FortiSwitch. The most specific match is tried first.
Only the vault's reference is sent; the password never leaves the vault.

**Before and after.** **Dry run** shows what a run would do — seeds, logins,
limits, commands — without sending anything. **Profile** saves the whole form
under a name (never a password) to use again.

**What it found.** **Findings** lists loops nothing blocks, duplicate MACs,
one-way links, drawn links nobody reported, spanning-tree-blocked links, up trunks
with nothing identified on them, and devices linked to nothing. Each device gets a
role — core, distribution, access, edge, firewall — with the reasons in its
**Role** field. On a page with Physical and Logical views, cables go on Physical
and layer-3 hops (dashed **L3** links) on Logical.

**Review before it lands.** **Add … to diagram** lists every change first: new and
changed devices ticked, moved and missing ones not. Only what you tick is applied,
as one undo step.

## More checks, and their history

**Kinds of check.** Besides ping, TCP, DNS and HTTP(S), a probe can be a **UDP
service reply** (it sends a DNS query, an NTP request or bytes you give, and is
healthy on any reply), a DNS check that **asks one server** for a record type,
or **SNMP uptime** with a saved credential — a device that restarted since the
last check shows as a warning.

**Templates.** **Save as template** on a probe, then add it to another device with
**From a template…**, or to every selected device at once.

**History.** Each probe shows its response time and status as sparklines, live or
over the last hour, day or three days, with how much of the time it was up.

**Path check.** The **Path check** tab asks whether one device can reach another:
from this machine on ICMP, a TCP port or a UDP port, or from a device using its
own ping over SSH. It shows the path the diagram draws between them, hop by hop,
and names the first one that is down.

**Compare.** The **Compare** tab puts two validation sessions, or two crawls,
side by side — availability and response times that got worse; firmware, ports,
neighbours and routes that changed — and saves the comparison as Markdown or CSV.

## Find your way around a big diagram

**Search everything.** **Ctrl+K** (⌘K on a Mac) opens one search over every
page: device names, addresses, MACs, hostnames, ports, VLANs, subnets, probes,
notes and shapes. Letters in order are enough — `csw1` finds `CORE-SW1`, and an
address or MAC matches with its dots and colons left out. Enter goes to the
result: its page, selected, in view. Picking a shape adds one. Type `>` first
for commands instead.

**Filter.** **Filter** in the top bar dims everything that does not match —
device type, vendor, role, tag, health, how it was discovered, VLAN, subnet or
text — so the rest stands out without anything being hidden or moved.

**Focus.** Right-click a device, or a selection, and **Focus on this** to dim all
but it and the devices one or two links away. **Escape** or the chip at the top leaves focus.

**On the device itself.** The inspector lists a device's **Neighbours** — port
here, device, port there, link state — each one a click away. **Attachments**
keeps paths to files that stay where they are (photos, manuals, configs) and
opens them. Select a link and it shows the **port at each end** as a crawl read
it: status, speed and duplex, VLAN or trunk, and error counters — so a link that
is up but dropping frames shows for what it is.

**Change many at once.** Select several devices, or several links, and the
inspector edits what they share — role, site, rack, vendor, tags — in one undo
step.

## Mark it up

**Sticky notes.** Drag **Sticky note** from the palette. Notes read Markdown:
headings, bullets, numbered lists, `- [ ]` checkboxes, quotes, rules, **bold**,
*italic*, ~~struck~~, `code` and links, and export the way they look.

**Ink.** **Pen** above the canvas draws freehand in five colours and four widths;
**Eraser** removes a stroke. Ink moves with the diagram, belongs to its page and
can be hidden — hidden ink is left out of exports. Escape puts the pen down.

**Comments.** Devices and links take comment threads: a name, a question or a
note, replies, and **Resolve** when it is dealt with (**Show resolved** brings
them back). A device with open
comments carries a badge.

## Work from the keyboard

**Alt+arrow** moves the selection to the nearest device in that direction.
**F6** moves between the palette, canvas, inspector and bottom panel; the bottom
panel's tabs move with the arrow keys. Every control has a name a screen reader
reads out. **?** lists every shortcut.

**High contrast.** Tick **High contrast** in the top bar for black and white
with strong status colours and a bold yellow focus ring. It starts on by itself
when the system asks for more contrast.

## Capture show commands

The **Backups** tab takes more than configurations. Tick **Show commands** and
write the commands you want, one per line — they run on every selected device,
and each device gets one file in its backup folder with every command's output
under its own heading and a note of when it was taken.

A device can have **its own** commands as well: set them under *Show commands*
in its inspector, and they run after the global list for that device only.
They only run when Show commands is ticked, so an ordinary backup never runs a
list typed earlier.

**Command sets** save typing the same list into every device of a kind. Under
*Command sets by role or tag*, choose **Add command set**, give it commands, and
say which **Roles** and **Tags** it applies to, separated by commas. Every
device whose *Role* field or tags match gets the set; case and extra spaces
don't matter. A device's commands run in this order: the global list, then
each matching set in the order the sets are listed, then its own, with any
command that repeats run once. The *Commands* column in the Backups table
shows each device's total and the sets it picked up. A set that names no role
and no tag applies to nothing. Sets are kept on your machine, and none come
built in.

**Paging.** Every session sends `terminal length 0` when it logs in and answers
any `--More--` prompt, which covers most Cisco, Dell and Arista kit. For the
rest, pick the platform under *Paging* and its own session-only command goes
first: ASA/FTD, Palo Alto, Aruba/HP, Juniper, Huawei/H3C. FortiOS has no
session-only pager command — its only one is a saved configuration change —
so Coreview answers its `--More--` prompts instead of changing the device.

**Only commands that read are ever sent.** A command must be a `show`,
`display` or `get` (or a paging command). Anything else — `reload`,
`configure terminal`, `copy`, `write`, `clear` — and any show piped into
`redirect`, `tee`, `append` or `save`, or sent to a file with `>`, refuses the
whole run before a single connection opens, and the message names the command.

A command a device does not recognise is kept in the file and marked, because
"this platform has no such command" is itself worth knowing. Commands that need
privilege still run on a device that refused enable; the file says it ran in
user mode.

The list and the paging choice are remembered between sessions. Coreview ships
with no commands filled in — the list is yours.

## Name capture files

Every capture is saved in its device's folder as
`20260828-101530-running-config.txt` unless you say otherwise. To name captures
the way a change record wants them, type a pattern under **File names** in the
Backups tab, for example `{site}_{device}_{date}_{stamp}_{kind}`. The preview
beside it shows the name the first selected device will get.

| Token | Becomes |
|---|---|
| `{stamp}` | date and time of the run, `20260828-101530` — **required** |
| `{kind}` | `running-config`, `startup-config` or `show-commands` — **required** |
| `{device}` | the device's name (its address when it has none) |
| `{address}` | the device's address |
| `{site}` | the device's *Site*, or the project's when the device has none |
| `{date}` | the date alone, `2026-08-28` |

`{stamp}` and `{kind}` are required because without them one capture would
overwrite another. A pattern missing either, or with a mistyped token such as
`{sit}`, is flagged as you type, and **Back up** stays off until it is fixed.

A pattern only names the file. It never changes which folder the file goes
in: anything that is not a letter, digit, dot, dash or underscore becomes a
dash, so neither the pattern nor a device's name can reach outside the device's
folder. A very long device name or site is shortened to fit; the stamp and kind
are never cut. Captures are listed newest first whatever the pattern, and
**Compare with previous** and the *unchanged* note keep working. Leave the
field blank to go back to the default.

## Collect in groups

A change window is usually collected in an order: the edge first, then what
sits behind it, then the rest, checking between steps. Under **Collect in
groups** in the Backups tab, choose **Add group** for each step. Give it a
name and the **Roles** and **Tags** that belong to it, separated by commas,
and use **↑** and **↓** to put the groups in order.

- A device joins the **first** group whose roles or tags match it, so it is
  never collected twice. The *Group* column in the device table shows where
  each one landed.
- Anything that matches no group is collected last, in **Everything else**.
  Groups with no selected devices are skipped.

Select devices and choose **Back up** as usual. Only the first group starts,
and a list shows each group as *Waiting*, *Running*, *Done* (with saved and
failed counts) or *Not run*. What happens when a group finishes depends on two
options, both on by default:

- **Pause between groups** waits after every group. Look at the results, then
  choose **Continue with …** or **Stop here**.
- **Stop when a group has a failure** waits only when something failed.
  Untick *Pause between groups* and a clean collection runs straight through,
  but still stops where a device could not be backed up, with the failure
  already listed below.

**Stop** cancels the group that is running; the groups after it are not run.
The form stays locked while a collection is paused, because what the next
group does was fixed when you pressed Back up.

Every group in one collection shares the same run time, so **Before and
after** and **Checks** treat the whole collection as one run. With no groups,
Back up works exactly as it always has. Groups are saved on your machine, and
none come built in.

## Before and after a change

Every device in one backup shares the same date and time, so a backup is a
**run**. Take one run before a maintenance window and one after it, with the
same devices and show commands. Then use **Before and after** at the foot of
the Backups tab:

1. Pick the **Before** and **After** runs. They start on the newest two, and
   each shows its date and how many devices it holds.
2. Choose **Compare runs**.

The result lists every device and every capture that is in either run:

- **Show commands are compared one command at a time**, so you see that
  `show ip route` gained a line and `show cdp neighbors` did not change,
  rather than one file that always differs because of its header. Every
  changed command shows its removed (`-`) and added (`+`) lines.
- **Configurations** are compared whole.
- A command, or a whole device, that is **in only one run** is listed as such,
  not left out. A switch backed up before a change and not after is exactly
  what a window review needs to notice.
- **Only what changed** is ticked by default. Untick it to see everything that
  stayed the same too.

Some things differ in every run: `show clock`, uptimes, counters. They show up
as changes because they are changes. A very long output, such as a full
routing table against another, is compared as sets of lines rather than line
by line, and says so. At most 400 changed lines are shown per command; the
counts are always complete.

Comparing only reads files in the backup folder. It never connects to a device.

## Check a run for pass or fail

Rather than reading every file after a window, write down what should be
true and let Coreview answer it for every device at once. Under **Checks** in
the Backups tab, choose **Add check** and fill in:

- **Command**: the show command whose output to look at, exactly as it was
  in your show-command list. Case and extra spaces don't matter.
- **Output**: what to expect.
  - *contains* and *does not contain* look for the text exactly as you typed
    it; `0.0.0.0/0` means those characters.
  - *matches* and *does not match* take a regular expression, where `^` and
    `$` are the start and end of a line.
- **Text or pattern**, and **Ignore case** if capitals shouldn't matter.

Pick a **Run** (only runs with show commands are listed) and choose **Run
checks**. Every device with show commands in that run gets one row per check:

| Result | Meaning |
|---|---|
| **Pass** | the output is as expected |
| **Fail** | it is not |
| **Not accepted** | the device refused the command, so there is no output to judge |
| **Not captured** | that command is not in this device's capture; add it to the list and back up again |

Each row says why and quotes the line that decided it, with its line number.
For a *contains* pass that's the line found; for a *does not contain* fail
it's the line that shouldn't be there. Failures are listed first, and **Only
what did not pass** hides the rest.

A check with no command or no text is kept but not run, and the panel says
how many are waiting. A regular expression that isn't valid is refused before
anything is read, naming the check. Checks are saved on your machine, and none
come built in. Running them only reads files already taken.

## Export evidence

Tick **Print-friendly** in the Export menu for a diagram in greys on white — no
header band, pale fills left unprinted, every mark dark enough to read on paper.
Statuses stay distinguishable without colour: each badge, link label and legend
entry carries its glyph (✓ ! ✕ ? ⚙), and a down link is dashed. It applies to SVG,
PNG, PDF and SVG sheets; an imported stencil's own artwork is left as it is.

The **Export** menu gives you:

- **Pages** — on a project with more than one page, choose **This page** or
  **All pages** for every drawing below
- **Diagram as PNG / SVG** — includes a title block with project, customer,
  site, ticket, engineer, timestamp, and a status legend; a file per page
- **Diagram as PDF** — vector; all pages go into one PDF, a page each
- **Diagram for Visio** and **Diagram for draw.io** — shapes and connectors a
  colleague can move, every page, with routed links keeping their bends
- **Interactive HTML page** — one file that opens in any browser, offline: page
  tabs, drag and zoom, search, and a device's details on a click. It loads
  nothing from anywhere
- **Print / save as PDF** — opens the print dialog with the canvas only
- **Events as CSV** — every state transition with timestamp, object, target,
  probe type, RTT and the failure text
- **Devices and links**, **Cable schedule**, **Ports**, **VLANs** and **Probe
  results as CSV** — every page
- **Validation report (Markdown)** — project metadata, object counts, status
  summary, the drawings (as images inside the file), the full transition table
  and the cable schedule
- **Project as a folder** — `project.coreview` and a readable `project.yaml` in
  a folder of their own, ready for Git. Unchanged projects write identical
  files; saved credentials are never included
- **Project package (.coreview)** — the whole project, importable elsewhere

## A report as a PDF

**Export → Report as PDF…** makes a document from one of four templates:

- **Pre-change baseline** — everything as it stands before a change
- **Post-change verification** — results now, and what changed since the
  previous validation session and crawl
- **Monthly health** — availability, response times, what is down, what changed
- **New-site handover** — drawings, inventory, ports, cables and checks

Each chooses its sections — summary, diagrams, device and port inventory, cable
schedule, check configuration, results, changes and an appendix — and you can
switch any of them on or off. Diagrams follow **Pages** in the Export menu.
Changes need two validation sessions or two crawls to compare.

## Bring in what you already have

**A spreadsheet.** **From a file** reads a CSV or an Excel workbook (`.xlsx`).
Choose the sheet, check the header row, say whether each row is a device or a
link, and match each field to a column — the guesses come from the column names
and every one can be changed. Nothing is added until **Add**. An old `.xls` has
to be saved as `.xlsx` first.

**NetBox.** The same tab reads a NetBox export saved as JSON or YAML — the API's
output for devices, cables and IP addresses, in one file or several. Devices
arrive with role, site, rack and position; cables become links. No token is
needed: nothing is contacted.

**A drawing.** **From a drawing** reads Visio (`.vsdx`) and draw.io (`.drawio`)
files, every page, with addresses, ports, line colours, routed bends and label
formatting. Lines that join nothing — a bus drawn as a line — are listed, not
guessed at.

**A saved walk.** **Discover devices → Open SNMP walks…** reads `snmpwalk`
output saved on another machine, one file per device, as if a crawl had reached
it over SNMP: identity, serials, addresses, LLDP and CDP neighbours and what is
plugged in. Walk with `-On` for the most complete result.

**An Nmap scan.** **Ping sweep → Open Nmap XML…** reads a scan saved with
`nmap -oX` into the sweep's rows.

## Move a project to another machine

Export the `.coreview` package, copy it over, and use **Import project** on the
welcome screen. Diagram, metadata, probes and health rules come across. Event
history does not — it stays with the machine that recorded it.
