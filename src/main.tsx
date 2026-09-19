import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { setLocale } from './i18n';
import './styles.css';

// LT-272: the system's language, where there is a catalogue for it; English
// otherwise, which today is always.
setLocale(navigator.language || 'en');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
