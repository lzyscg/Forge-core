import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createBrowserMockGateway } from './app';
import { resolveForgeCoreMode } from './gateway/gateway-mode';
import { createHttpGateway } from './gateway/http-gateway';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

// One Gateway for the whole page lifetime, decided before React renders
// (spec §15.4): every task read/write goes through the same implementation,
// never mixed per task. VITE_FORGE_CORE_MODE=http binds the real JSON API;
// anything else keeps the deterministic mock. Formal pages never branch on
// the mode — only /dev/progress displays it.
const developmentGateway = createBrowserMockGateway();
const coreGateway =
  resolveForgeCoreMode(import.meta.env.VITE_FORGE_CORE_MODE) === 'http'
    ? createHttpGateway()
    : developmentGateway;

createRoot(container).render(
  <StrictMode>
    <App core={coreGateway} development={developmentGateway} />
  </StrictMode>,
);
