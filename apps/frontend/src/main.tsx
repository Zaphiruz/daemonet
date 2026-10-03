import { configureStore } from '@reduxjs/toolkit';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { api } from './api.ts';
import { App } from './App.tsx';
import './styles.css';

const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: (gdm) => gdm().concat(api.middleware) });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
