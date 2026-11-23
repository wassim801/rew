import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Ignore third-party browser extension injection failures (e.g. MetaMask inpage.js in sandboxed iframes)
// while keeping all application errors surfaced normally.
if (typeof window !== 'undefined') {
  const isExtensionNoise = (message?: string, source?: string, stack?: string): boolean => {
    const combined = `${message ?? ''} ${source ?? ''} ${stack ?? ''}`;
    return (
      combined.includes('chrome-extension://') ||
      combined.includes('moz-extension://') ||
      combined.includes('Failed to connect to MetaMask')
    );
  };

  window.addEventListener(
    'error',
    (event) => {
      if (isExtensionNoise(event.message, event.filename, event.error?.stack)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );

  window.addEventListener(
    'unhandledrejection',
    (event) => {
      const reason = event.reason as { message?: string; stack?: string } | string | undefined;
      const msg = typeof reason === 'string' ? reason : reason?.message;
      const stack = typeof reason === 'object' ? reason?.stack : undefined;
      if (isExtensionNoise(msg, undefined, stack)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );
}

createRoot(document.getElementById('root')!).render(<App />);
