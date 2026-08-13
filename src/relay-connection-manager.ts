import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import type { RelayConnectionStatus } from "./types.js";

const CONNECTION_TIMEOUT_MS = 3_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface RelayLike {
  onclose: (() => void) | null;
}

export interface RelayPoolLike {
  ensureRelay(
    url: string,
    params?: { connectionTimeout?: number; abort?: AbortSignal },
  ): Promise<RelayLike>;
  close(relays: string[]): void;
}

export type RelayPoolFactory = () => RelayPoolLike;

function createRelayPool(): RelayPoolLike {
  useWebSocketImplementation(WebSocket);
  return new SimplePool({ enablePing: true, enableReconnect: false });
}

export class RelayConnectionManager {
  private readonly relays: string[];
  private readonly poolFactory: RelayPoolFactory;
  private readonly statuses = new Map<string, RelayConnectionStatus>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeRelays = new Map<string, RelayLike>();
  private readonly connectionControllers = new Map<string, AbortController>();
  private readonly connectionPromises = new Map<string, Promise<void>>();
  private pool: RelayPoolLike | null = null;
  private active = false;
  private generation = 0;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  public constructor(relays: string[], poolFactory: RelayPoolFactory = createRelayPool) {
    this.relays = [...new Set(relays)];
    this.poolFactory = poolFactory;

    for (const url of this.relays) {
      this.statuses.set(url, { url, state: "disconnected", reconnectAttempts: 0 });
    }
  }

  public getRelayStatuses(): RelayConnectionStatus[] {
    return this.relays.map((url) => ({ ...this.getStatus(url) }));
  }

  public start(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise.then(() => this.start());
    }
    if (this.active) {
      return this.startPromise ?? Promise.resolve();
    }

    this.active = true;
    const generation = ++this.generation;
    try {
      this.pool = this.poolFactory();
    } catch (error) {
      this.active = false;
      this.pool = null;
      for (const url of this.relays) {
        this.updateStatus(url, "disconnected", 0);
      }
      return Promise.reject(error);
    }

    const initialConnections = this.relays.map((url) => {
      this.updateStatus(url, "connecting", 0);
      return this.connectRelay(url, generation);
    });

    const startPromise = Promise.allSettled(initialConnections).then(() => undefined);
    this.startPromise = startPromise;
    void startPromise.finally(() => {
      if (this.generation === generation) {
        this.startPromise = null;
      }
    });

    return startPromise;
  }

  public stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.active) {
      return Promise.resolve();
    }

    const stopPromise = this.stopLifecycle();
    this.stopPromise = stopPromise;
    const clearStopPromise = () => {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    };
    void stopPromise.then(clearStopPromise, clearStopPromise);
    return stopPromise;
  }

  private connectRelay(url: string, generation: number): Promise<void> {
    const currentConnection = this.connectionPromises.get(url);
    if (currentConnection) {
      return currentConnection;
    }

    const connectionPromise = this.performConnection(url, generation);
    this.connectionPromises.set(url, connectionPromise);
    const clearConnection = () => {
      if (this.connectionPromises.get(url) === connectionPromise) {
        this.connectionPromises.delete(url);
      }
    };
    void connectionPromise.then(clearConnection, clearConnection);
    return connectionPromise;
  }

  private async performConnection(url: string, generation: number): Promise<void> {
    const pool = this.pool;
    if (!pool || !this.isActiveGeneration(generation)) {
      return;
    }

    const connectionController = new AbortController();
    this.connectionControllers.set(url, connectionController);
    try {
      const relay = await pool.ensureRelay(url, {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        abort: connectionController.signal,
      });
      if (!this.isActiveGeneration(generation)) {
        pool.close([url]);
        return;
      }

      const poolCloseHandler = relay.onclose;
      relay.onclose = () => {
        poolCloseHandler?.();
        this.handleRelayClose(url, relay, generation);
      };
      this.activeRelays.set(url, relay);
      this.updateStatus(url, "connected", 0);
    } catch {
      if (this.isActiveGeneration(generation)) {
        this.scheduleReconnect(url, generation);
      }
    } finally {
      if (this.connectionControllers.get(url) === connectionController) {
        this.connectionControllers.delete(url);
      }
    }
  }

  private handleRelayClose(url: string, relay: RelayLike, generation: number): void {
    if (this.activeRelays.get(url) !== relay) {
      return;
    }

    this.activeRelays.delete(url);
    if (this.isActiveGeneration(generation)) {
      this.scheduleReconnect(url, generation);
    }
  }

  private scheduleReconnect(url: string, generation: number): void {
    if (this.reconnectTimers.has(url)) {
      return;
    }

    const reconnectAttempts = this.getStatus(url).reconnectAttempts + 1;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** (reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.updateStatus(url, "reconnecting", reconnectAttempts);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(url);
      void this.connectRelay(url, generation);
    }, delay);
    this.reconnectTimers.set(url, timer);
  }

  private isActiveGeneration(generation: number): boolean {
    return this.active && this.generation === generation;
  }

  private async stopLifecycle(): Promise<void> {
    this.active = false;
    this.generation += 1;

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    const pool = this.pool;
    const startPromise = this.startPromise;
    const connectionPromises = [...this.connectionPromises.values()];
    let closeError: unknown;
    try {
      pool?.close(this.relays);
    } catch (error) {
      closeError = error;
    }
    for (const controller of this.connectionControllers.values()) {
      controller.abort();
    }
    await Promise.allSettled([...connectionPromises, ...(startPromise ? [startPromise] : [])]);

    this.activeRelays.clear();
    this.connectionControllers.clear();
    this.connectionPromises.clear();
    this.pool = null;
    this.startPromise = null;
    for (const url of this.relays) {
      this.updateStatus(url, "disconnected", 0);
    }

    if (closeError) {
      throw closeError;
    }
  }

  private getStatus(url: string): RelayConnectionStatus {
    const status = this.statuses.get(url);
    if (!status) {
      throw new Error(`Unknown relay: ${url}`);
    }
    return status;
  }

  private updateStatus(
    url: string,
    state: RelayConnectionStatus["state"],
    reconnectAttempts: number,
  ): void {
    this.statuses.set(url, { url, state, reconnectAttempts });
  }
}
