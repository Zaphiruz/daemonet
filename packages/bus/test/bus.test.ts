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
  it('does not crash the process on connection errors, and close is idempotent', async () => {
    const bus = new RedisBus('redis://127.0.0.1:1/0');
    await expect(bus.publish('x', { a: 1 })).rejects.toBeTruthy();
    await bus.close();
    await bus.close();
  });
});

const url = process.env.REDIS_URL;
describe.skipIf(!url)('RedisBus (needs REDIS_URL)', () => {
  it('publishes and receives across two buses under the daemonet: prefix', async () => {
    const a = new RedisBus(url!);
    const b = new RedisBus(url!);
    await Promise.all([a.ready(), b.ready()]);
    const got: unknown[] = [];
    b.subscribe('admin', (m) => got.push(m));
    await new Promise((r) => setTimeout(r, 100));
    await a.publish('admin', { kind: 'mute', operatorId: 'x' });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([{ kind: 'mute', operatorId: 'x' }]);
    await Promise.all([a.close(), b.close()]);
  });
});
