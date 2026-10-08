# A real SN2010 on Cumulus Linux 5.18

One reply per file, captured by the operator on 2026-10-06 and
reduced to invented names, documentation addresses and changed MACs and
serials before they were committed. `vtysh_*` and `lldpcli_*` were
run under `sudo`, which Coreview never sends; their layouts are read
because NVUE's LLDP view prints lldpd's and FRR's are what a login allowed
`vtysh` sees. Both engines read these through `coreview_discover::nvue`.
