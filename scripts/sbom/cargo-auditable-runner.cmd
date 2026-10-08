@echo off
rem `tauri build --runner` takes one program and hands it `build ...`;
rem cargo-auditable refuses to run unless cargo starts it. This is that bridge:
rem the Windows binary is built with its dependency list embedded, so
rem `cargo audit bin coreview.exe` can check the exact thing that shipped.
cargo auditable %*
