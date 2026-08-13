import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RelayConnectionManager,
  type RelayLike,
  type RelayPoolLike,
} from "../relay-connection-manager.js";

const RELAYS = ["wss://relay.one", "wss://relay.two"];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

class FakeRelay implements RelayLike {
  public onclose: (() => void) | null = null;

  public drop(): void {
    this.onclose?.();
  }
}

class FakePool implements RelayPoolLike {
  public ensureRelayCalls: string[] = [];
  public closeCalls: string[][] = [];
  private readonly connectedRelays = new Map<string, RelayLike>();

  public constructor(
    private readonly connect: (
      url: string,
      params?: { connectionTimeout?: number; abort?: AbortSignal },
    ) => Promise<RelayLike>,
    private readonly emitCloseOnPoolClose = false,
    private readonly closeError?: Error,
  ) {}

  public ensureRelay(
    url: string,
    _params?: { connectionTimeout?: number; abort?: AbortSignal },
  ): Promise<RelayLike> {
    this.ensureRelayCalls.push(url);
    return this.connect(url, _params).then((relay) => {
      this.connectedRelays.set(url, relay);
      return relay;
    });
  }

  public close(relays: string[]): void {
    this.closeCalls.push([...relays]);
    if (this.emitCloseOnPoolClose) {
      for (const url of relays) {
        this.connectedRelays.get(url)?.onclose?.();
      }
    }
    if (this.closeError) {
      throw this.closeError;
    }
  }
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("RelayConnectionManager startup", () => {
  it("starts every configured relay concurrently and tracks successful connections", async () => {
    const first = deferred<RelayLike>();
    const second = deferred<RelayLike>();
    const connections = new Map([
      [RELAYS[0], first],
      [RELAYS[1], second],
    ]);
    const pool = new FakePool((url) => {
      const connection = connections.get(url);
      if (!connection) {
        throw new Error(`Unexpected relay: ${url}`);
      }
      return connection.promise;
    });
    const manager = new RelayConnectionManager(RELAYS, () => pool);

    expect(manager.getRelayStatuses()).toEqual([
      { url: RELAYS[0], state: "disconnected", reconnectAttempts: 0 },
      { url: RELAYS[1], state: "disconnected", reconnectAttempts: 0 },
    ]);

    const startPromise = manager.start();

    expect(pool.ensureRelayCalls).toEqual(RELAYS);
    expect(manager.getRelayStatuses()).toEqual([
      { url: RELAYS[0], state: "connecting", reconnectAttempts: 0 },
      { url: RELAYS[1], state: "connecting", reconnectAttempts: 0 },
    ]);

    first.resolve(new FakeRelay());
    second.resolve(new FakeRelay());
    await startPromise;

    expect(manager.getRelayStatuses()).toEqual([
      { url: RELAYS[0], state: "connected", reconnectAttempts: 0 },
      { url: RELAYS[1], state: "connected", reconnectAttempts: 0 },
    ]);
  });

  it("keeps healthy relays connected when another initial connection fails", async () => {
    vi.useFakeTimers();
    const pool = new FakePool(async (url) => {
      if (url === RELAYS[0]) {
        return new FakeRelay();
      }
      throw new Error("relay unavailable");
    });
    const manager = new RelayConnectionManager(RELAYS, () => pool);

    await expect(manager.start()).resolves.toBeUndefined();

    expect(manager.getRelayStatuses()).toEqual([
      { url: RELAYS[0], state: "connected", reconnectAttempts: 0 },
      { url: RELAYS[1], state: "reconnecting", reconnectAttempts: 1 },
    ]);
  });

  it("returns status snapshots that cannot mutate manager state", () => {
    const pool = new FakePool(async () => new FakeRelay());
    const manager = new RelayConnectionManager(RELAYS, () => pool);
    const snapshot = manager.getRelayStatuses();

    snapshot[0].state = "connected";
    snapshot[0].reconnectAttempts = 99;
    snapshot.push({ url: "wss://injected", state: "connected", reconnectAttempts: 0 });

    expect(manager.getRelayStatuses()).toEqual([
      { url: RELAYS[0], state: "disconnected", reconnectAttempts: 0 },
      { url: RELAYS[1], state: "disconnected", reconnectAttempts: 0 },
    ]);
  });
});

describe("RelayConnectionManager reconnection", () => {
  it("reconnects a dropped relay only after the first backoff delay", async () => {
    vi.useFakeTimers();
    const connectedRelays: FakeRelay[] = [];
    const pool = new FakePool(async () => {
      const relay = new FakeRelay();
      connectedRelays.push(relay);
      return relay;
    });
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);
    await manager.start();

    connectedRelays[0].drop();

    expect(manager.getRelayStatuses()).toEqual([
      { url: RELAYS[0], state: "reconnecting", reconnectAttempts: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(999);
    expect(pool.ensureRelayCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(pool.ensureRelayCalls).toHaveLength(2);
    expect(manager.getRelayStatuses()).toEqual([
      { url: RELAYS[0], state: "connected", reconnectAttempts: 0 },
    ]);
  });

  it("uses 1, 2, 4, 8, 16, then capped 30 second retry delays", async () => {
    vi.useFakeTimers();
    const initialRelay = new FakeRelay();
    let connectionCount = 0;
    const pool = new FakePool(async () => {
      connectionCount += 1;
      if (connectionCount === 1) {
        return initialRelay;
      }
      throw new Error("relay unavailable");
    });
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);
    await manager.start();
    initialRelay.drop();

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [index, delay] of expectedDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(pool.ensureRelayCalls).toHaveLength(index + 1);

      await vi.advanceTimersByTimeAsync(1);
      expect(pool.ensureRelayCalls).toHaveLength(index + 2);
      expect(manager.getRelayStatuses()[0]).toEqual({
        url: RELAYS[0],
        state: "reconnecting",
        reconnectAttempts: index + 2,
      });
    }
  });

  it("resets the backoff after success so a later drop retries after one second", async () => {
    vi.useFakeTimers();
    const connectedRelays: FakeRelay[] = [];
    const pool = new FakePool(async () => {
      const relay = new FakeRelay();
      connectedRelays.push(relay);
      return relay;
    });
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);
    await manager.start();

    connectedRelays[0].drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(manager.getRelayStatuses()[0].reconnectAttempts).toBe(0);

    connectedRelays[1].drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(pool.ensureRelayCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(pool.ensureRelayCalls).toHaveLength(3);
  });

  it("does not create parallel reconnects for repeated close notifications", async () => {
    vi.useFakeTimers();
    const initialRelay = new FakeRelay();
    const pool = new FakePool(async () => initialRelay);
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);
    await manager.start();

    initialRelay.drop();
    initialRelay.drop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pool.ensureRelayCalls).toHaveLength(2);
  });
});

describe("RelayConnectionManager lifecycle", () => {
  it("shares concurrent start calls without opening duplicate connections", async () => {
    const connection = deferred<RelayLike>();
    const pool = new FakePool(async () => connection.promise);
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);

    const firstStart = manager.start();
    const secondStart = manager.start();

    expect(secondStart).toBe(firstStart);
    expect(pool.ensureRelayCalls).toEqual([RELAYS[0]]);

    connection.resolve(new FakeRelay());
    await firstStart;
  });

  it("recovers cleanly when pool construction fails", async () => {
    const pool = new FakePool(async () => new FakeRelay());
    let factoryCalls = 0;
    const manager = new RelayConnectionManager([RELAYS[0]], () => {
      factoryCalls += 1;
      if (factoryCalls === 1) {
        throw new Error("pool construction failed");
      }
      return pool;
    });

    await expect(manager.start()).rejects.toThrow("pool construction failed");
    expect(manager.getRelayStatuses()[0].state).toBe("disconnected");

    await expect(manager.start()).resolves.toBeUndefined();
    expect(pool.ensureRelayCalls).toEqual([RELAYS[0]]);
  });

  it("closes every relay and cancels pending reconnects on stop", async () => {
    vi.useFakeTimers();
    const relay = new FakeRelay();
    const pool = new FakePool(async () => relay, true);
    const manager = new RelayConnectionManager(RELAYS, () => pool);
    await manager.start();

    relay.drop();
    await manager.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(pool.closeCalls).toEqual([RELAYS]);
    expect(pool.ensureRelayCalls).toHaveLength(RELAYS.length);
    expect(manager.getRelayStatuses()).toEqual([
      { url: RELAYS[0], state: "disconnected", reconnectAttempts: 0 },
      { url: RELAYS[1], state: "disconnected", reconnectAttempts: 0 },
    ]);
  });

  it("aborts and settles an unresolved initial connection on stop", async () => {
    const connection = deferred<RelayLike>();
    const pool = new FakePool((_url, params) => {
      params?.abort?.addEventListener("abort", () => {
        connection.reject(new Error("connection aborted"));
      });
      return connection.promise;
    });
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);
    const startPromise = manager.start();

    await expect(manager.stop()).resolves.toBeUndefined();
    await expect(startPromise).resolves.toBeUndefined();

    expect(pool.closeCalls).toEqual([[RELAYS[0]]]);
    expect(manager.getRelayStatuses()[0]).toEqual({
      url: RELAYS[0],
      state: "disconnected",
      reconnectAttempts: 0,
    });
  });

  it("uses an independent abort signal for each concurrent connection", () => {
    const signals: AbortSignal[] = [];
    const pool = new FakePool((_url, params) => {
      if (params?.abort) {
        signals.push(params.abort);
      }
      return new Promise<RelayLike>(() => {});
    });
    const manager = new RelayConnectionManager(RELAYS, () => pool);

    void manager.start();

    expect(signals).toHaveLength(RELAYS.length);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("waits for an in-flight reconnect attempt to settle before stop resolves", async () => {
    vi.useFakeTimers();
    const initialRelay = new FakeRelay();
    const reconnect = deferred<RelayLike>();
    let connectionCount = 0;
    let reconnectAborted = false;
    const pool = new FakePool((_url, params) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        return Promise.resolve(initialRelay);
      }
      params?.abort?.addEventListener("abort", () => {
        reconnectAborted = true;
      });
      return reconnect.promise;
    });
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);
    await manager.start();
    initialRelay.drop();
    await vi.advanceTimersByTimeAsync(1_000);

    let stopSettled = false;
    const stopPromise = manager.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(reconnectAborted).toBe(true);
    expect(stopSettled).toBe(false);

    reconnect.reject(new Error("connection aborted"));
    await stopPromise;
    expect(stopSettled).toBe(true);
  });

  it("does not reconnect when pool close emits relay close callbacks", async () => {
    vi.useFakeTimers();
    const relay = new FakeRelay();
    const pool = new FakePool(async () => relay, true);
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);
    await manager.start();

    await manager.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(pool.ensureRelayCalls).toEqual([RELAYS[0]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes cleanup even when the pool close operation throws", async () => {
    const pool = new FakePool(async () => new FakeRelay(), false, new Error("pool close failed"));
    const manager = new RelayConnectionManager([RELAYS[0]], () => pool);
    await manager.start();

    await expect(manager.stop()).rejects.toThrow("pool close failed");

    expect(manager.getRelayStatuses()[0]).toEqual({
      url: RELAYS[0],
      state: "disconnected",
      reconnectAttempts: 0,
    });
  });

  it("makes repeated stop harmless and supports a fresh restart", async () => {
    const pools: FakePool[] = [];
    const manager = new RelayConnectionManager([RELAYS[0]], () => {
      const pool = new FakePool(async () => new FakeRelay());
      pools.push(pool);
      return pool;
    });

    await manager.start();
    await manager.stop();
    await manager.stop();
    await manager.start();

    expect(pools).toHaveLength(2);
    expect(pools[0].closeCalls).toEqual([[RELAYS[0]]]);
    expect(pools[1].ensureRelayCalls).toEqual([RELAYS[0]]);
    expect(manager.getRelayStatuses()[0].state).toBe("connected");
  });
});
