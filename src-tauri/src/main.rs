// Windows: no console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod icons;
mod stencil_manifest;
mod pdf;
mod shapeconv;
mod visio;
mod spreadsheet;
mod ratelimit;
mod jobs;
mod timeline;
mod keychain;
#[cfg(test)]
mod ipc_contract;
#[cfg(test)]
mod file_properties;
mod commands;
mod discovery;
mod collection;
mod collection_db;
mod terminal;
mod vault_commands;
mod meraki;
mod updater;
mod db;

use std::sync::{Arc, Mutex};

use commands::AppState;
use coreview_probe::{Engine, DEFAULT_MAX_CONCURRENCY};
use tauri::{Manager, RunEvent, WindowEvent};

/// Sizes the window to the screen it opens on.
///
/// A fixed default cannot fit every display: 1600x1000 is comfortable on a
/// desktop and larger than the whole screen on a 1366x768 laptop, where the
/// window opens with its edges off the display and its buttons unreachable.
/// Scaled displays make it worse — 1920x1080 at 150% is 1280x720 of usable
/// space, and nothing about the reported resolution says so.
///
/// So the window is asked for a proportion of whatever it actually opens on,
/// capped at a size beyond which more pixels stop helping, and floored at the
/// smallest layout that still works. Failure is silent and harmless: the
/// window keeps the size from the config, which is what happened before.
fn fit_to_screen(app: &tauri::App) {
    use tauri::{LogicalSize, Manager};

    const MAX_W: f64 = 1600.0;
    const MAX_H: f64 = 1000.0;
    const MIN_W: f64 = 900.0;
    const MIN_H: f64 = 600.0;
    // Leaves room for a taskbar, dock or panel, which no API reliably reports.
    const OF_SCREEN: f64 = 0.9;

    let Some(window) = app.get_webview_window("main") else { return };
    let Ok(Some(monitor)) = window.current_monitor() else { return };

    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);

    let width = (size.width * OF_SCREEN).clamp(MIN_W, MAX_W);
    let height = (size.height * OF_SCREEN).clamp(MIN_H, MAX_H);

    let _ = window.set_size(LogicalSize::new(width, height));

    // Positioned explicitly rather than with center(). That reads the window's
    // current size to work out where the middle is, and the resize above has
    // not necessarily been applied by the time it looks — so it centred a
    // window it believed had no size and put the top-left at the middle of the
    // screen, leaving more than half the window off the display. Computing the
    // position from the size just asked for has no such race.
    let x = ((size.width - width) / 2.0).max(0.0);
    let y = ((size.height - height) / 2.0).max(0.0);
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

/// How an SNMP uptime check reads a device. The probe names a saved
/// credential by id; the vault is opened here, in Rust, when the check runs, and
/// the secret goes no further than the SNMP request.
fn register_snmp_uptime(handle: tauri::AppHandle) {
    coreview_probe::snmpcheck::register(Box::new(move |cfg| {
        let handle = handle.clone();
        Box::pin(async move {
            let id = cfg.snmp_credential_id.clone().unwrap_or_default();
            let auth = {
                let state = handle.state::<AppState>();
                let auth = vault_commands::snmp_credentials(&state, &id)?;
                vault_commands::note_use(&state, &id, "SNMP uptime check", &cfg.target);
                auth
            };
            let timeout = std::time::Duration::from_millis(cfg.timeout_ms.max(500));
            let found = coreview_discover::snmp::identify(&cfg.target, 161, &auth, timeout)
                .await
                .map_err(|e| e.to_string())?;
            found
                .uptime_ticks
                .ok_or_else(|| format!("{} answered SNMP but gave no uptime", cfg.target))
        })
    }));
}

fn main() {
    let db_path = db::data_dir().join("coreview.db");
    let conn = db::open(&db_path).expect("could not open the local Coreview database");
    // Sweep up anything a project deleted before the cascade existed left
    // behind — its event timeline carries device names and the addresses they
    // were checked at, which is exactly what deleting a project is for.
    match db::purge_orphans(&conn) {
        Ok(0) => {}
        Ok(n) => eprintln!("removed {n} rows belonging to projects that no longer exist"),
        // Not fatal: a start that refuses to happen is worse than one that
        // leaves the sweeping until next time.
        Err(e) => eprintln!("could not sweep up after deleted projects: {e}"),
    }
    // A crawl the last process died under is kept with what it had
    // found, and says so.
    match db::mark_abandoned_runs(&conn) {
        Ok(0) => {}
        Ok(n) => eprintln!("{n} crawl run(s) were still running when the app last closed; kept as aborted"),
        Err(e) => eprintln!("could not mark abandoned crawl runs: {e}"),
    }
    let (engine, rx) = Engine::new(DEFAULT_MAX_CONCURRENCY);
    let engine_for_exit = Arc::clone(&engine);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Asks GitHub for a newer release only when told to; see updater.rs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::Pending::default())
        .manage(AppState {
            engine,
            db: Mutex::new(conn),
            session_id: Mutex::new(None),
            project_id: Mutex::new(None),
            jobs: Arc::new(jobs::Jobs::default()),
            vault_key: Mutex::new(None),
            limiter: ratelimit::RateLimiter::default(),
            sessions: std::sync::Arc::new(terminal::Sessions::default()),
            export_targets: commands::ExportTargets::default(),
            open_project: Mutex::new(None),
        })
        .setup(move |app| {
            // Every change to a running job reaches the window on
            // one event, whichever panel started it.
            let jobs_window = app.handle().clone();
            app.state::<AppState>().jobs.report_to(move |snapshot| {
                use tauri::Emitter;
                let _ = jobs_window.emit("coreview://job", &snapshot);
            });
            commands::pump_events(app.handle().clone(), rx);
            register_snmp_uptime(app.handle().clone());
            fit_to_screen(app);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window must stop probing before the process exits.
            if let WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                let engine = Arc::clone(&state.engine);
                tauri::async_runtime::block_on(async move { engine.stop().await });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::set_open_project,
            vault_commands::assign_credential,
            commands::save_project,
            commands::load_project,
            commands::delete_project,
            commands::set_project_archived,
            commands::list_project_folders,
            commands::create_project_folder,
            commands::rename_project_folder,
            commands::move_project_folder,
            commands::delete_project_folder,
            commands::move_project_to_folder,
            commands::test_probe_now,
            commands::validate_target,
            commands::traceroute_now,
            commands::open_external_url,
            commands::open_attachment,
            commands::start_validation,
            commands::stop_validation,
            commands::update_validation,
            commands::session_status,
            commands::probe_snapshot,
            commands::probe_history,
            commands::list_sessions,
            commands::session_summary,
            commands::list_crawl_runs,
            commands::crawl_run_result,
            commands::job_list,
            commands::job_cancel,
            commands::crawl_timeline,
            commands::list_events,
            commands::record_event,
            commands::app_info,
            updater::check_for_update,
            updater::install_update,
            commands::list_icon_library,
            commands::list_bundled_icons,
            commands::list_stencil_packs,
            commands::remove_stencil_pack,
            commands::diagram_pdf,
            commands::diagram_vsdx,
            commands::save_export,
            commands::pick_export_target,
            commands::pick_export_folder,
            commands::read_import,
            commands::read_spreadsheet,
            commands::save_project_folder,
            commands::ipc_refused,
            terminal::ssh_open,
            terminal::ssh_send,
            terminal::ssh_resize,
            terminal::ssh_close,
            terminal::ssh_close_all,
            terminal::ssh_sessions,
            terminal::ssh_log_start,
            terminal::ssh_log_stop,
            terminal::ssh_keepalive,
            terminal::ssh_external,
            terminal::ssh_test_credential,
            vault_commands::list_credential_use,
            vault_commands::clear_credential_use,
            vault_commands::remember_vault_key,
            vault_commands::forget_vault_key,
            vault_commands::unlock_vault_from_keychain,
            commands::import_visio,
            commands::import_drawio,
            commands::diagram_pdf_pages,
            commands::get_settings,
            commands::set_setting,
            commands::check_folder_writable,
            commands::start_sweep,
            commands::cancel_sweep,
            commands::describe_subnet,
            discovery::start_crawl,
            collection::start_collection,
            collection::cancel_collection,
            collection::list_collection_runs,
            collection::collection_run,
            collection::collection_table,
            collection::shadow_report,
            collection::collection_topology,
            collection::collection_path,
            collection::collection_diff,
            collection::collection_live,
            collection::collection_raw,
            collection::import_captures,
            discovery::cancel_crawl,
            discovery::ping_from_device,
            discovery::traceroute_from_device,
            discovery::ecmp_leg_from_device,
            discovery::read_snmp_walk,
            discovery::read_nmap_xml,
            discovery::start_backup,
            discovery::cancel_backup,
            discovery::list_backup_devices,
            discovery::list_device_captures,
            discovery::device_capture_history,
            discovery::read_capture,
            discovery::diff_captures,
            discovery::list_backup_runs,
            discovery::compare_backup_runs,
            discovery::run_backup_checks,
            discovery::read_gateway_arp,
            discovery::list_host_keys,
            discovery::clear_host_keys,
            discovery::forget_host_key,
            vault_commands::vault_status,
            vault_commands::create_vault,
            vault_commands::unlock_vault,
            vault_commands::lock_vault,
            vault_commands::discard_vault,
            vault_commands::save_credential,
            meraki::meraki_organizations,
            meraki::meraki_networks,
            meraki::meraki_profiles,
            meraki::meraki_backup,
            meraki::meraki_health_check,
            meraki::meraki_discover,
            vault_commands::list_credentials,
            vault_commands::reveal_credential,
            vault_commands::export_vault,
            vault_commands::import_vault,
            vault_commands::delete_credential,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Coreview")
        .run(move |_app, event| {
            if let RunEvent::Exit = event {
                let engine = Arc::clone(&engine_for_exit);
                tauri::async_runtime::block_on(async move { engine.stop().await });
            }
        });
}
