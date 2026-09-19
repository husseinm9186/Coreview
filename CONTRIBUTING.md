# Contributing to Coreview

**Read this first.** Coreview is **free to use and free to pass on**, and is not
open source — see [`LICENSE`](LICENSE). You may install it anywhere and give the
installer to anyone, unchanged and never for a fee. What the licence reserves is
modifying it, selling it, and building derivative works from it.

The source is published so that anyone pointing this at a network can read
exactly what it does, which is the whole argument of the *Privacy* section of
the README. Being able to read it is not permission to reuse it.

So: **issues and bug reports are welcome from anyone.** If you want to send a
patch, ask first — a pull request cannot be merged without an agreement about
rights, and it is unfair to let someone write one without knowing that. The rest
of this document is the working guide for the author and anyone working at his
direction.

Coreview is a local-first desktop app for network engineers. Before changing
anything, read these, in order:

1. `CLAUDE.md` — the standing rules and the checks every change runs.
2. `docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/OPEN-QUESTIONS.md` — what is
   being built, what was decided and why, and what is still undecided.
3. `docs/HANDOVER.md` — the map of the code and the traps that have bitten.
4. **`docs/BRAND_AND_LICENSING.md`** — why there are no vendor icons, and why
   you must not add any.

## The lines that are not crossed

- **No vendor artwork** — no logos, icons or stencil packs from Cisco, Juniper,
  Arista, Palo Alto, Fortinet, F5 or anyone else, not even "to be helpful".
  Draw a vendor-neutral class shape instead (D-028).
- **No customer data** — names, addresses, hostnames, command lists, procedures
  or diagrams from a real network never reach a commit, a default, a template
  or a fixture (D-027).
- **No secrets** — no credential, real or plausible, in code, fixtures or
  exports (D-006).
- **No cloud, accounts, telemetry, crash reporting or update pings**, and no
  network call the operator did not start.
- **Every new Tauri command** is explicitly named, validates its input, and is
  documented.

## How work is done

- A new task goes into `docs/ROADMAP.md` before the work starts; one ask, one
  item.
- A bug is reproduced by a failing test before it is fixed (D-020).
- A failing test is never fixed by weakening it.
- Roadmap and decision changes are committed with the code they describe.
- "It compiles" is not "it works": run the checks in `CLAUDE.md`, including the
  browser harnesses under `e2e/`.
