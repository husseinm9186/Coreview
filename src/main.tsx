import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { setLocale } from './i18n';
import { watchUnhandled } from './lib/unhandled';
import { useStore } from './state/store';
import './styles.css';

// LT-450: a fire-and-forget call that failed says so in the status bar
// rather than in a console the bundle has no window for.
watchUnhandled(window, (line) => useStore.getState().setStatusMessage(line));

// LT-272: the system's language, where there is a catalogue for it; English
// otherwise, which today is always.
setLocale(navigator.language || 'en');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
