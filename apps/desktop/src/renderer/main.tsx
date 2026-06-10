import './globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.js';
import { ToastProvider } from './components/ui/toast.js';
import { ConfirmProvider } from './components/ui/confirm-dialog.js';

// Why: HashRouter is used instead of BrowserRouter because Electron loads the
// renderer via file:// protocol, which doesn't support HTML5 history push state.
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    {/* Why: opt into v7 behaviors now to silence the future-flag console warnings. */}
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </ToastProvider>
    </HashRouter>
  </StrictMode>,
);
