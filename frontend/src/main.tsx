import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installChunkLoadRecovery } from './chunkLoadRecovery.js';

installChunkLoadRecovery();

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  window.dispatchEvent(new Event('nwa:app-started'));
}
