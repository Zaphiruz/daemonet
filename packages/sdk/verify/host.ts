import { buildSandboxHtml, createBridge, SANDBOX_ATTRIBUTES } from '@daemonet/sandbox';
import type { OperatorSelf } from '@daemonet/shared';

const log = (line: string) => {
  const el = document.getElementById('log')!;
  el.textContent += line + '\n';
};
const self: OperatorSelf = {
  id: 'op1',
  name: 'alice',
  starterClaimed: true,
  x: 5,
  y: 5,
  bits: 0,
  ram: [],
  running: [],
  inventory: {},
  swapReadyTick: 0,
  capture: null,
};
const sdkBundle = await (await fetch('/sdk.js')).text();
const source = `
export default async function main(game) {
  let cookie; try { cookie = JSON.stringify(document.cookie); } catch (e) { cookie = 'blocked: ' + e.name; }
  console.log('hello from sandbox, tick', game.tick, 'me', game.self.name, 'cookie?', cookie);
  try { await fetch('/api/me'); console.log('fetch allowed?!'); } catch (e) { console.log('fetch blocked:', String(e.message)); }
  await game.operator.stop();
  console.log('stop acked');
}`;
const iframe = document.createElement('iframe');
iframe.setAttribute('sandbox', SANDBOX_ATTRIBUTES);
iframe.srcdoc = buildSandboxHtml({ sdkBundle, source });
const channel = new MessageChannel();
const bridge = createBridge({
  port: channel.port1,
  send: (frame) => {
    log('host<-sandbox cmd: ' + frame.slice(0, 60));
    const reqId = (JSON.parse(frame) as { d: { reqId: string } }).d.reqId;
    bridge.deliver(JSON.stringify({ t: 'ack', seq: 1, d: { reqId } }));
  },
  state: () => ({ operatorId: 'op1', role: 'controller', tick: 7, subnet: 'lo', self, entities: [] }),
});
window.addEventListener('message', (ev) => {
  if (ev.source !== iframe.contentWindow) return;
  log('sandbox says: ' + JSON.stringify(ev.data));
});
iframe.addEventListener('load', () => iframe.contentWindow!.postMessage({ type: 'init' }, '*', [channel.port2]));
document.body.append(iframe);
log('host ready; document.cookie on host = ' + JSON.stringify(document.cookie));
