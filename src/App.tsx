import { cycleRegion } from './lib/regions';
import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import { Canvas } from './components/Canvas';
import { Inspector } from './components/inspector/Inspector';
import { Palette } from './components/Palette';
import { ProjectScreen } from './components/ProjectScreen';
import { HelpScreen } from './components/HelpScreen';
import { RegisterScreen } from './components/RegisterScreen';
import { StatusPanel } from './components/StatusPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TopBar } from './components/TopBar';
import { ipc, isDesktop } from './lib/ipc';

/** LT-262: the keychain is asked at most once per window. */
let keychainTried = false;
import { useStore } from './state/store';

export default function App() {
  const meta = useStore((s) => s.meta);
  const highContrast = useStore((s) => s.settings.highContrast);
  const ground = useStore((s) => s.settings.ground);
  const applyEngineEvent = useStore((s) => s.applyEngineEvent);
  // Read above the early return: a hook after one is called conditionally,
  // which React rejects and which broke the move from the launcher into a
  // project entirely.
  const selection = useStore((s) => s.selectedNodeId ?? s.selectedEdgeId);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);
  const presenting = useStore((s) => s.presenting);
  const registerOpen = useStore((s) => s.registerOpen);
  const helpOpen = useStore((s) => s.helpOpen);

  // LT-193: presentation takes the whole screen where the window can go full
  // screen, and leaving full screen by the system's own means leaves
  // presentation too. Where full screen is refused, the chrome still goes.
  useEffect(() => {
    if (!presenting) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      return;
    }
    let entered = false;
    const onChange = () => {
      if (document.fullscreenElement) entered = true;
      else if (entered) useStore.getState().setPresenting(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [presenting]);

  // LT-262: a vault whose key this machine keeps opens by itself — once per
  // window, however often the effect runs.
  useEffect(() => {
    if (keychainTried) return;
    keychainTried = true;
    void ipc.unlockVaultFromKeychain().then((r) => {
      if (r === 'stale') useStore.getState().setStatusMessage('The key kept in the system keychain no longer opens the vault, so it was removed. Unlock with the passphrase.');
    }).catch((e: unknown) => useStore.getState().setStatusMessage(e instanceof Error ? e.message : String(e)));
  }, []);

  // Engine events arrive on one channel for the life of the window.
  useEffect(() => {
    let un: (() => void) | undefined;
    void ipc.onEngineEvent(applyEngineEvent).then((f) => {
      un = f;
    });
    return () => un?.();
  }, [applyEngineEvent]);

  // Belt and braces alongside the Rust-side window close handler.
  useEffect(() => {
    const stop = () => {
      if (useStore.getState().session.state !== 'stopped') void ipc.stopValidation();
    };
    window.addEventListener('beforeunload', stop);
    return () => window.removeEventListener('beforeunload', stop);
  }, []);

  // LT-240: F6 and Shift+F6 move between the toolbar, palette, diagram,
  // inspector and bottom panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F6') return;
      e.preventDefault();
      cycleRegion(e.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!meta) {
    return (
      <div className={`cv-app ${highContrast ? 'is-contrast' : ''} ${ground === 'light' ? 'is-light' : ''}`}>
        {!isDesktop && (
          <div className="cv-browser-banner">
            Running in a browser. Projects are kept in browser storage and no probing is possible —
            start the desktop app with <code>npm run tauri dev</code> to run checks.
          </div>
        )}
        <ProjectScreen />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div
        className={`cv-app cv-workspace ${highContrast ? 'is-contrast' : ''} ${ground === 'light' ? 'is-light' : ''}${
          presenting ? ' is-presenting' : ''
        }`}
      >
        <ErrorBoundary what="The toolbar"><TopBar onExit={() => undefined} /></ErrorBoundary>
        {/* LT-300: the register takes the whole workspace when it is open. The
            diagram below stays mounted — React Flow rebuilds its viewport from
            scratch when unmounted, so leaving the register would otherwise come
            back to a diagram that had jumped. */}
        {registerOpen && (
          <ErrorBoundary what="The address register"><RegisterScreen /></ErrorBoundary>
        )}
        {helpOpen && <ErrorBoundary what="The guide"><HelpScreen /></ErrorBoundary>}
        {/* The narrow layouts show the palette or the inspector, not both,
            and which one depends on whether there is something to inspect. */}
        <div
          className={[
            'cv-main',
            registerOpen || helpOpen ? 'is-behind' : '',
            selection ? 'has-selection' : '',
            paletteOpen ? '' : 'palette-hidden',
            inspectorOpen ? '' : 'inspector-hidden',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {/* Both stay mounted and are hidden in CSS. Unmounting one leaves
              two children in a three-track grid, and the canvas slides into
              the collapsed track — which is how the inspector ended up
              occupying the middle of the window. */}
          <ErrorBoundary what="The shape palette"><Palette /></ErrorBoundary>
          <ErrorBoundary what="The diagram"><Canvas /></ErrorBoundary>
          <ErrorBoundary what="The inspector"><Inspector /></ErrorBoundary>

          {/* Slim rails, so the way back is always visible. A panel that
              hides with no handle left behind reads as something broken. */}
          <button
            type="button"
            className="cv-rail cv-rail-left"
            onClick={() => setPaletteOpen(!paletteOpen)}
            title={paletteOpen ? 'Hide the shapes panel' : 'Show the shapes panel'}
            aria-label={paletteOpen ? 'Hide the shapes panel' : 'Show the shapes panel'}
            aria-expanded={paletteOpen}
          >
            {paletteOpen ? '‹' : '›'}
          </button>
          <button
            type="button"
            className="cv-rail cv-rail-right"
            onClick={() => setInspectorOpen(!inspectorOpen)}
            title={inspectorOpen ? 'Hide the details panel' : 'Show the details panel'}
            aria-label={inspectorOpen ? 'Hide the details panel' : 'Show the details panel'}
            aria-expanded={inspectorOpen}
          >
            {inspectorOpen ? '›' : '‹'}
          </button>
        </div>
        {!registerOpen && !helpOpen && (
          <ErrorBoundary what="The monitoring panel"><StatusPanel /></ErrorBoundary>
        )}
      </div>
    </ReactFlowProvider>
  );
}
