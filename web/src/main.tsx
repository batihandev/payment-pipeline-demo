import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PaymentsPanel } from './panel';

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <PaymentsPanel apiBaseUrl={import.meta.env.VITE_API_URL ?? ''} />
    </StrictMode>,
  );
