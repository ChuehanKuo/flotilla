import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('root element not found');

createRoot(container).render(
  <StrictMode>
    <div style={{ height: '100vh', width: '100vw' }}>
      <App />
    </div>
  </StrictMode>,
);
