# Brands and licensing

Why Coreview has no Cisco, Juniper or Fortinet icons, what it has instead, and
where your own stencils fit. The decision is **D-028**; this is the working
explanation of it.

## The split

| | What it is | Who owns it | Shipped? |
| --- | --- | --- | --- |
| **Built-in shapes** | One original outline per device class — router, L3 and L2 switch, firewall, load balancer, WAF, patch panel, PDU and so on (`src/components/icons.tsx`) | The Coreview project, licensed with the app | Yes |
| **Vendor and model** | Plain-text fields on a device: `vendor = "Juniper"`, `model = "MX960"` | Whoever types them | Data, not artwork |
| **Your stencils** | SVGs, Visio stencils or decks you import through the icon library, optionally described by a manifest | Their owner — you are responsible for your right to use them | Never |

A router whose vendor is Juniper and model MX960 draws the generic router
outline with a text label. That is the same model NetBox and Nautobot use.

## Why not ship vendor icons, as Lucidchart and Visio do

Lucidchart, Visio and draw.io can carry vendor icons because they either license
them or run as a hosted service with a takedown process. Coreview is local-first,
offline and given away publicly; it has neither. Vendor icons and logos are
trademarks and copyrighted artwork, and a redistributed installer carrying them
would expose the project and everyone who passes it on.

So Coreview:

- ships **no** vendor icons, logos or stencil packs — in the repository or the
  installer (a test fails if artwork reappears under `stencils/`);
- **never downloads** them — not at install time, not on first run, not in an
  update;
- draws no shape by tracing a vendor's artwork.

## Your own stencils

You can still use any artwork you have the right to use:

1. Put it in a folder of your own — never under the repository's `stencils/`.
2. Point the icon library at that folder.
3. Optionally describe the shapes with a manifest (LT-169) so each one arrives
   with its class, vendor, model, ports and rack units.

**You are responsible for the licensing of anything you import.** Coreview does
not ship, fetch or update vendor packs, and cannot tell you whether you may use
one.

When a project uses imported stencils, exporting it warns that third-party
artwork may be included, and a **vendor-safe export** replaces each imported
stencil with the built-in shape for its class — use it for anything shared
outside your organisation (LT-170).

## For contributors

- Do not add vendor logos, icons, stencils or "brand" glyphs, however helpful
  they would be. Add a device *class* shape instead, drawn from scratch.
- Do not name a vendor in a shape's label, a default, a placeholder or a port
  naming scheme. Defaults are generic: `Port {n}`, not `GigabitEthernet1/0/{n}`.
  `src/lib/shapeCatalog.test.ts` checks both.
- Test fixtures are invented artwork (D-027 keeps real customer data out; this
  keeps vendor artwork out). A test that needs a real vendor file reads it from
  a local path and skips without it — see `COREVIEW_VSS_FIXTURE` in
  `docs/HANDOVER.md`.

## The project's own licence

**Answered 2026-09-18 (LT-308), which closes Q-009.** Coreview is proprietary
and free to use: the `LICENSE` file at the root carries the terms, and they are
shown in About and in the README.

> Coreview is proprietary software, made available free of charge for lawful
> use. It may be passed on to anyone, unchanged, with its licence and notices
> alongside it, and never for a fee. Selling it, modifying it, reverse
> engineering it, rebranding it or creating derivative works needs prior
> written permission from Mohammed Almoola.
>
> © 2026 Mohammed Almoola. All rights reserved.

**Two corrections on 2026-09-18 (LT-313).** The first version forbade passing
it on at all, which contradicted the point of the thing — it is meant to be
shared between network engineers, and a colleague who could not hand on the
installer was a colleague who could not share it. And **no trademark is claimed
on the name**: the ™ that reached the installer's licence page asserted a mark
that is not owned, on a name an established company already uses. Both are
gone.

That covers Coreview's own code **and its own shapes**, which is what the rest
of this document is about: the shapes are drawn here (D-028), so they are
Coreview's to licence. Nothing in it touches the licences of the open-source
components the app is built on — those are unchanged, and credited in
`THIRD-PARTY-NOTICES.md`, which every installer carries because MIT and
Apache-2.0 require it and a proprietary licence is not an exemption.
