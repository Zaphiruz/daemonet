import { configureStore } from '@reduxjs/toolkit';
import { api } from './api.ts';

/** The page's Redux store (RTK Query cache); the connection store invalidates tags on live events. */
export const store = configureStore({ reducer: { [api.reducerPath]: api.reducer }, middleware: (gdm) => gdm().concat(api.middleware) });
