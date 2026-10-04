import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { MemoryBus, PREFIX, RedisBus, createBus } from '../src/index.js';

describe('MemoryBus', () => {
  it('delivers JSON copies to every subscriber of a channel, asynchronously, and honours unsubscribe', async () => {
    const bus = new MemoryBus();
    const got: unknown[] = [];
    const off = bus.subscribe('chat', (m) => got.push(m));
    bus.subscribe('chat', (m) => got.push({ second: m }));
    const msg = { text: 'hi', nested: { n: 1 } };
    const p = bus.publish('chat', msg);
    expect(got).toEqual([]);
    await p;
    expect(got).toEqual([msg, { second: msg }]);
    expect(got[0]).not.toBe(msg);
    off();
    await bus.publish('chat', { text: 'again' });
    expect(got).toHaveLength(3);
    await bus.publish('other', { x: 1 });
    expect(bus.log.map((l) => l.channel)).toEqual(['chat', 'chat', 'other']);
  });

  it('createBus picks MemoryBus without a URL', () => {
    expect(createBus(undefined)).toBeInstanceOf(MemoryBus);
    expect(PREFIX).toBe('daemonet:');
  });

  it('caps the publish log', async () => {
    const bus = new MemoryBus(2);
    for (let i = 0; i < 5; i++) await bus.publish('c', i);
    expect(bus.log.map((l) => l.message)).toEqual([3, 4]);
  });

  it('close is idempotent and a throwing handler does not break other subscribers', async () => {
    const bus = new MemoryBus();
    const got: unknown[] = [];
    bus.subscribe('c', () => {
      throw new Error('boom');
    });
    bus.subscribe('c', (m) => got.push(m));
    await bus.publish('c', { a: 1 });
    expect(got).toEqual([{ a: 1 }]);
    await bus.close();
    await bus.close();
  });
});

describe('RedisBus without a server', () => {
  it('subscribe while Redis is down neither throws nor crashes', async () => {
    const bus = new RedisBus('redis://127.0.0.1:1/0');
    bus.subscribe('x', () => undefined)();
    bus.subscribe('y', () => undefined);
    await new Promise((r) => setTimeout(r, 300));
    await bus.close();
  });

  it('does not crash the process on connection errors, and close is idempotent', async () => {
    const bus = new RedisBus('redis://127.0.0.1:1/0');
    await expect(bus.publish('x', { a: 1 })).rejects.toBeTruthy();
    await bus.close();
    await bus.close();
  });
});

const url = process.env.REDIS_URL;
describe.skipIf(!url)('RedisBus (needs REDIS_URL)', () => {
  it('publishes and receives across two buses under the daemonet: prefix, including self-delivery', async () => {
    const a = new RedisBus(url!);
    const b = new RedisBus(url!);
    const raw = new Redis(url!);
    await Promise.all([a.ready(), b.ready()]);
    const got: unknown[] = [];
    const own: unknown[] = [];
    const wire: string[] = [];
    raw.on('message', (ch: string) => wire.push(ch));
    await raw.subscribe('daemonet:admin');
    b.subscribe('admin', (m) => got.push(m));
    a.subscribe('admin', (m) => own.push(m));
    await new Promise((r) => setTimeout(r, 100));
    await a.publish('admin', { kind: 'mute', operatorId: 'x' });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([{ kind: 'mute', operatorId: 'x' }]);
    expect(own).toEqual([{ kind: 'mute', operatorId: 'x' }]);
    expect(wire).toEqual(['daemonet:admin']);
    await Promise.all([a.close(), b.close(), raw.quit()]);
  });

  it('re-issues SUBSCRIBE for wanted channels when the subscriber connection becomes ready', async () => {
    const a = new RedisBus(url!);
    const b = new RedisBus(url!);
    await Promise.all([a.ready(), b.ready()]);
    const got: unknown[] = [];
    b.subscribe('lost', (m) => got.push(m));
    await new Promise((r) => setTimeout(r, 100));
    // Simulate a SUBSCRIBE that never took effect (lost during an outage).
    const sub = (b as unknown as { sub: Redis }).sub;
    await sub.unsubscribe('daemonet:lost');
    await a.publish('lost', { n: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([]);
    sub.emit('ready');
    await new Promise((r) => setTimeout(r, 100));
    await a.publish('lost', { n: 2 });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([{ n: 2 }]);
    await Promise.all([a.close(), b.close()]);
  });
});
