/*
 * /sandbox/bootstrap.js — the sandbox iframe's main thread (bundled as a classic script by
 * `build:static`). The document is an opaque origin, so a Worker cannot load a URL directly: the
 * worker is a blob: script that importScripts the same-origin SDK and runtime by absolute URL
 * (allowed by `script-src 'self'`, which matches the document's URL origin).
 */
import { SANDBOX_SDK_PATH, SANDBOX_WORKER_PATH } from '../document.js';
import { runFrame, type FrameWorker } from '../frame.js';

const sdkUrl = new URL(SANDBOX_SDK_PATH, location.href).href;
const workerUrl = new URL(SANDBOX_WORKER_PATH, location.href).href;

runFrame({
  postToParent: (m) => parent.postMessage(m, '*'),
  onParentMessage: (listener) =>
    addEventListener('message', (ev) => {
      if (ev.source !== parent) return;
      listener(ev.data, ev.ports);
    }),
  createWorker: () => {
    const blob = new Blob([`importScripts(${JSON.stringify(sdkUrl)}, ${JSON.stringify(workerUrl)});\n`], { type: 'text/javascript' });
    return new Worker(URL.createObjectURL(blob)) as unknown as FrameWorker;
  },
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as number),
});
