/*
 * /sandbox/worker.js — runs inside the blob: worker after /sandbox/sdk.js defined `DaemonetSDK`
 * (bundled as a classic script by `build:static`). The player's module is imported from a blob:
 * URL (`script-src blob:`); the worker inherits the document CSP, so it has no network.
 */
import type * as Sdk from '@daemonet/sdk';
import { errorMessage, runWorker } from '../worker-runtime.js';

declare const DaemonetSDK: typeof Sdk;

interface Scope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (ev: ErrorEvent) => void): void;
  addEventListener(type: 'unhandledrejection', listener: (ev: PromiseRejectionEvent) => void): void;
}
const scope = globalThis as unknown as Scope;

// The script's own uncaught errors are reported here (and kept from the iframe's worker.onerror,
// which means "the worker failed to start").
scope.addEventListener('error', (ev) => {
  ev.preventDefault();
  scope.postMessage(errorMessage(ev.error ?? ev.message));
});
scope.addEventListener('unhandledrejection', (ev) => {
  ev.preventDefault();
  scope.postMessage(errorMessage(ev.reason));
});

runWorker({
  post: (m) => scope.postMessage(m),
  onMessage: (listener) => scope.addEventListener('message', (ev) => listener(ev.data, ev.ports)),
  sdk: DaemonetSDK,
  importModule: (source) => import(/* @vite-ignore */ URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))) as Promise<{ default?: unknown }>,
  console: console as unknown as Record<string, unknown>,
  setInterval: (fn, ms) => setInterval(fn, ms),
});
