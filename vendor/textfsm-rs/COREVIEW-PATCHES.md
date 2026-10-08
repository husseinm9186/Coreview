# textfsm-rs 0.3.6, as Coreview carries it

The crate as published on crates.io (Apache-2.0, LICENSE beside this file,
https://github.com/itsvrushabh/textfsm-rs), with three changes, each marked
`COREVIEW PATCH` in the source. They make it give Python TextFSM's rows on
the whole ntc-templates test suite (LT-525): 1895 of 1895, against 1889
without them. The crate's own tests still pass. Offering them upstream is a
pull request under the operator's account, his call; this copy goes when a
release carries them.

1. `src/lib.rs`, `process_record_action`: a record skipped because a
   `Required` value is empty is cleared (Filldown values kept), as Python's
   `_AppendRecord` does. Without it a `List` value from the skipped record
   leaks into the next record — `mikrotik_routeros_interface_print_detail`
   and `linux_iwlist_wlan0_scanning`.
2. `src/textfsm.pest`, `regex_pattern`: a Value's regex runs from its first
   `(` to the last `)` on the line, as Python accepts it, rather than exactly
   one balanced group — `hp_procurve_show_interfaces_status`, whose regex is a
   group followed by a look-ahead.
3. `src/lib.rs`, `process_record_action`: an empty value does not satisfy
   `Required`, as Python's `if not self._value.value` has it; an optional
   group that did not match leaves `""`, which used to count —
   `linux_iwlist_wlan0_scanning`, whose first cell has an empty SSID.
