/*
 * What the isolation frame lets through to Rust (LT-258).
 *
 * Every message the page sends passes through here, in a sandboxed frame the
 * page's own scripts cannot reach, before Tauri encrypts it for the backend.
 * A message is refused unless it names a command Coreview has, carries only
 * that command's own arguments, and stays within sane size and depth. A refused
 * message is sent on as `ipc_refused`, which fails with the reason, so the
 * page's call rejects with an explanation instead of reaching the command.
 *
 * `rules.test.ts` checks the table below against every `#[tauri::command]` in
 * src-tauri and the list registered in main.rs, so it cannot fall behind.
 * Plain ES5 on purpose: nothing is built or bundled into this frame.
 */
(function (root) {
  'use strict';

  /** Each command, and the argument names the page may send it. */
  var COMMANDS = {
    app_info: [],
    cancel_backup: [],
    cancel_crawl: [],
    cancel_sweep: [],
    check_folder_writable: ["path"],
    clear_credential_use: [],
    clear_host_keys: [],
    compare_backup_runs: ["before", "after"],
    crawl_run_result: ["id"],
    create_vault: ["passphrase"],
    delete_credential: ["id"],
    delete_project: ["id"],
    describe_subnet: ["subnet"],
    diagram_pdf: ["svg"],
    diagram_pdf_pages: ["svgs"],
    diagram_vsdx: ["drawing"],
    diff_captures: ["device", "before", "after"],
    discard_vault: [],
    export_vault: [],
    forget_host_key: ["host", "port"],
    forget_vault_key: [],
    get_settings: [],
    import_drawio: ["path"],
    import_vault: ["vault", "passphrase"],
    import_visio: ["path"],
    ipc_refused: ["command", "reason"],
    list_backup_devices: [],
    list_backup_runs: [],
    list_bundled_icons: [],
    list_crawl_runs: ["projectId"],
    list_credential_use: ["credentialId", "limit"],
    list_credentials: [],
    list_device_captures: ["device"],
    list_events: ["projectId", "limit"],
    list_host_keys: [],
    list_icon_library: ["dir"],
    list_projects: [],
    list_sessions: ["projectId"],
    list_stencil_packs: [],
    load_project: ["id"],
    lock_vault: [],
    open_attachment: ["path", "reveal"],
    open_external_url: ["url"],
    ping_from_device: ["device", "credentialId", "target", "count"],
    probe_history: ["probeId", "sinceMs", "limit"],
    probe_snapshot: [],
    read_capture: ["device", "filename"],
    read_gateway_arp: ["gateway", "credentialId"],
    read_import: ["path"],
    read_nmap_xml: ["text"],
    read_snmp_walk: ["text", "address"],
    read_spreadsheet: ["path"],
    record_event: ["event"],
    remember_vault_key: [],
    remove_stencil_pack: ["name"],
    reveal_credential: ["id"],
    run_backup_checks: ["stamp", "checks"],
    save_crawl_run: ["projectId", "seed", "result"],
    save_credential: ["credential"],
    save_export: ["path", "contentsB64"],
    save_project: ["package"],
    save_project_folder: ["folder", "name", "json", "yaml"],
    session_status: [],
    session_summary: ["sessionId"],
    set_project_archived: ["id", "archived"],
    set_setting: ["key", "value"],
    start_backup: ["input", "credentials", "stamp"],
    start_crawl: ["input", "credentials", "fallbackCredentials"],
    start_sweep: ["subnets", "options"],
    start_validation: ["projectId", "operator", "probes"],
    stop_validation: [],
    test_probe_now: ["config"],
    traceroute_now: ["target"],
    unlock_vault: ["passphrase"],
    unlock_vault_from_keychain: [],
    update_validation: ["probes"],
    validate_target: ["target"],
    vault_status: []
  };

  /** The plugin calls the page makes: events, and the two file dialogs. */
  var PLUGINS = ['plugin:event|listen', 'plugin:event|unlisten', 'plugin:dialog|open', 'plugin:dialog|save'];

  var MAX_DEPTH = 64;
  var MAX_NODES = 5000000;
  var MAX_TEXT = 256 * 1024 * 1024;
  var POISON = ['__proto__', 'constructor', 'prototype'];

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  /** Why a value is too much, or null. */
  function measure(value) {
    var stack = [[value, 0]];
    var nodes = 0;
    var text = 0;
    while (stack.length) {
      var item = stack.pop();
      var v = item[0];
      var depth = item[1];
      nodes += 1;
      if (nodes > MAX_NODES) return 'it is too large';
      if (typeof v === 'string') {
        text += v.length;
        if (text > MAX_TEXT) return 'it carries too much text';
      } else if (v && typeof v === 'object') {
        if (depth >= MAX_DEPTH) return 'it is nested too deeply';
        if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
        var keys = Object.keys(v);
        for (var i = 0; i < keys.length; i += 1) {
          if (!Array.isArray(v) && POISON.indexOf(keys[i]) >= 0) return 'it names a field "' + keys[i] + '"';
          stack.push([v[keys[i]], depth + 1]);
        }
      }
    }
    return null;
  }

  /** Why a message is refused, or null to let it through. */
  function check(message) {
    if (!message || typeof message.cmd !== 'string') return 'it names no command';
    var cmd = message.cmd;
    var args = message.payload;
    if (PLUGINS.indexOf(cmd) >= 0) return measure(args);
    if (cmd.indexOf('plugin:') === 0) return 'the page has no use for ' + cmd;
    if (!has(COMMANDS, cmd)) return 'Coreview has no command called ' + cmd;
    if (args === undefined || args === null) return null;
    if (typeof args !== 'object' || Array.isArray(args) || ArrayBuffer.isView(args) || args instanceof ArrayBuffer) {
      return 'its arguments are not named';
    }
    var allowed = COMMANDS[cmd];
    var keys = Object.keys(args);
    for (var i = 0; i < keys.length; i += 1) {
      if (allowed.indexOf(keys[i]) < 0) return 'it sends "' + keys[i] + '", which ' + cmd + ' does not take';
    }
    return measure(args);
  }

  /** The hook itself: the message, or a refusal in its place. */
  function guard(message) {
    var reason = check(message);
    if (reason === null) return message;
    return {
      cmd: 'ipc_refused',
      callback: message && message.callback,
      error: message && message.error,
      options: message && message.options,
      payload: { command: String(message && message.cmd).slice(0, 80), reason: reason },
    };
  }

  root.coreviewIsolation = { COMMANDS: COMMANDS, PLUGINS: PLUGINS, check: check, guard: guard };
})(typeof window !== 'undefined' ? window : globalThis);
