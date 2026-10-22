import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PaymentsPanel } from './panel';
import { PaymentsWidget } from './payments/widget';

const apiBaseUrl = import.meta.env.VITE_API_URL ?? '';
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      {new URLSearchParams(location.search).get('view') === 'widget' ? (
        <PaymentsWidget apiBaseUrl={apiBaseUrl} />
      ) : (
        <PaymentsPanel apiBaseUrl={apiBaseUrl} />
      )}
    </StrictMode>,
  );
