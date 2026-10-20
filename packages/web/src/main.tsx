import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/prototype.css';
import './styles/extra.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
