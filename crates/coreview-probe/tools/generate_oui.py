#!/usr/bin/env python3
"""Turns the IEEE MAC registries into the table src/oui_data.rs.

    cd "$(mktemp -d)"
    curl -O https://standards-oui.ieee.org/oui/oui.csv
    curl -O https://standards-oui.ieee.org/oui28/mam.csv
    curl -O https://standards-oui.ieee.org/oui36/oui36.csv
    python3 crates/coreview-probe/tools/generate_oui.py oui.csv mam.csv oui36.csv

The registries are 5 MB of CSV with postal addresses in them. This keeps the
assignment and a shortened organisation name, which is all a diagram label
needs, and sorts by prefix so the lookup can binary search.

**Three registries, not one.** IEEE sells address space in three sizes: MA-L
is the classic 24-bit prefix, MA-M is 28 bits and MA-S is 36 bits, the last
two carved out of blocks IEEE keeps in its own name. Read MA-L alone and
every device in one of those blocks comes back "IEEE Registration Authority",
which is true and useless — that is what a Proxmox host on the operator's
network reported before the smaller registries were added.
"""
import csv
import re
import sys

# Legal suffixes are noise on a diagram: "Cisco Systems, Inc" and "Cisco
# Systems" are the same thing to someone reading a network map.
SUFFIXES = [
    r",?\s+(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|l\.l\.c|gmbh|ag|s\.a|sa|s\.p\.a|spa|b\.v|bv|n\.v|nv|a/s|as|oy|ab|plc|pty|pte|srl|s\.r\.l|kg|kk|k\.k)\.?$",
    r",?\s+(technologies|technology|electronics|electronic|systems|system|networks|solutions)\s+(inc|corp|co|ltd|llc|gmbh)\.?$",
]


def clean(name: str) -> str:
    """Drops characters the registry carries that source code should not.

    Zero-width spaces and other invisibles appear in a handful of entries and
    are rejected outright by `clippy -D warnings`, so this is not cosmetic.
    """
    return "".join(c for c in name if c.isprintable() and not c.isspace() or c == " ")


def shorten(name: str) -> str:
    n = " ".join(clean(name).split()).strip().strip(",")
    for _ in range(3):
        before = n
        for pattern in SUFFIXES:
            n = re.sub(pattern, "", n, flags=re.IGNORECASE).strip().strip(",")
        if n == before:
            break
    # A name that shortened away to nothing keeps its original.
    return n if n else " ".join(name.split())


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    # One bucket per prefix width, keyed by the number of hex digits the
    # registry writes: 6 for MA-L, 7 for MA-M, 9 for MA-S.
    entries = {6: {}, 7: {}, 9: {}}
    for path in sys.argv[1:]:
        with open(path, newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                assignment = (row.get("Assignment") or "").strip().upper()
                org = (row.get("Organization Name") or "").strip()
                width = len(assignment)
                if width not in entries or not org or org.lower() == "private":
                    continue
                try:
                    prefix = int(assignment, 16)
                except ValueError:
                    continue
                entries[width][prefix] = shorten(org)

    # Half the assignments repeat an organisation — Cisco alone holds
    # hundreds — so the names are deduplicated and referenced by index. As
    # 40,000 separate string literals the table costs 2.2 MB of binary; this
    # brings it down to a fraction of that.
    names = sorted({v for bucket in entries.values() for v in bucket.values()})
    index = {name: i for i, name in enumerate(names)}
    assert len(names) < 65536, "the index no longer fits in a u16"

    out = [
        "//! Generated from the IEEE MA-L, MA-M and MA-S registries by",
        "//! tools/generate_oui.py.",
        "//!",
        "//! Do not edit. Regenerate when the registries are refreshed:",
        "//!",
        "//! ```text",
        "//! curl -O https://standards-oui.ieee.org/oui/oui.csv",
        "//! curl -O https://standards-oui.ieee.org/oui28/mam.csv",
        "//! curl -O https://standards-oui.ieee.org/oui36/oui36.csv",
        "//! python3 crates/coreview-probe/tools/generate_oui.py \\",
        "//!     oui.csv mam.csv oui36.csv",
        "//! ```",
        "",
        "/// Every organisation name, once each.",
        "pub static VENDORS: &[&str] = &[",
    ]
    for name in names:
        escaped = name.replace("\\", "\\\\").replace('"', '\\"')
        out.append(f'    "{escaped}",')
    out.append("];")
    out.append("")
    out.append("/// The first three bytes of a MAC (MA-L), and an index into")
    out.append("/// VENDORS. Sorted by prefix, so the lookup can binary search.")
    out.append("pub static OUI: &[(u32, u16)] = &[")
    for prefix in sorted(entries[6]):
        out.append(f"    (0x{prefix:06X}, {index[entries[6][prefix]]}),")
    out.append("];")
    out.append("")
    out.append("/// MA-M: the first 28 bits, held in the low 28 bits of the key.")
    out.append("/// Checked before OUI, because an MA-M block sits inside an")
    out.append("/// MA-L one that IEEE registered to itself.")
    out.append("pub static OUI_28: &[(u32, u16)] = &[")
    for prefix in sorted(entries[7]):
        out.append(f"    (0x{prefix:07X}, {index[entries[7][prefix]]}),")
    out.append("];")
    out.append("")
    out.append("/// MA-S: the first 36 bits. Checked before both of the above.")
    out.append("pub static OUI_36: &[(u64, u16)] = &[")
    for prefix in sorted(entries[9]):
        out.append(f"    (0x{prefix:09X}, {index[entries[9][prefix]]}),")
    out.append("];")
    out.append("")

    path = "crates/coreview-probe/src/oui_data.rs"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out))
    counts = ", ".join(f"{len(entries[w])} at {w * 4} bits" for w in (6, 7, 9))
    print(f"{counts} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
