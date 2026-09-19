/* LT-258: hand every message to the rules before Tauri encrypts it. */
window.__TAURI_ISOLATION_HOOK__ = function (message) {
  return window.coreviewIsolation.guard(message);
};
