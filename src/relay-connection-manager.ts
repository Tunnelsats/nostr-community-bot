import WebSocket from "ws";
import { isIP } from "node:net";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import type { Filter, NostrEvent } from "nostr-tools";
import {
  createPublicLookup,
  isPublicIpAddress,
  resolveHostname,
  type HostnameResolver,
} from "./dm-relays.js";
import type { RelayConnectionStatus } from "./types.js";

const CONNECTION_TIMEOUT_MS = 3_000;
const PUBLICATION_TIMEOUT_MS = 5_000;
const STOP_DRAIN_TIMEOUT_MS = 5_000;
const MAX_QUERY_EVENTS_PER_RELAY = 32;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RELAY_PUBLICATION_FAILED = "Relay publication failed";
const RELAY_QUERY_FAILED = "Relay query failed";
const MAX_WEBSOCKET_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_PERSISTENT_RELAY_COUNT = 32;

export function validatePublicRelayAddress(address: string | URL): string | URL {
  if (
    typeof address === "string" &&
    (address.length === 0 || address.length > 2_048)
  ) {
    throw new Error("Relay URL must target a public IP address over wss");
  }
  const url = address instanceof URL ? address : new URL(address);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "wss:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    hostname.length === 0 ||
    hostname.toLowerCase() === "localhost" ||
    (isIP(hostname) !== 0 && !isPublicIpAddress(hostname))
  ) {
    throw new Error("Relay URL must target a public IP address over wss");
  }
  return address;
}

export interface RelaySubscriptionLike {
  close(reason?: string): void;
}

export interface RelayLike {
  onclose: (() => void) | null;
  subscribe(
    filters: Filter[],
    params: { onevent?: (event: NostrEvent) => void; oneose?: () => void },
  ): RelaySubscriptionLike;
  publish(event: NostrEvent): Promise<string>;
}

export interface RelayPoolLike {
  ensureRelay(
    url: string,
    params?: { connectionTimeout?: number; abort?: AbortSignal },
  ): Promise<RelayLike>;
  close(relays: string[]): void;
}

export type RelayPoolFactory = () => RelayPoolLike;

type RelayEventHandler = (event: NostrEvent) => Promise<void> | void;

interface SubscriptionRegistration {
  id: number;
  filter: Filter;
  handler: RelayEventHandler;
}

export function createPublicWebSocketImplementation(
  resolver: HostnameResolver = resolveHostname,
  BaseWebSocket: typeof WebSocket = WebSocket,
): typeof WebSocket {
  class PublicRelayWebSocket extends BaseWebSocket {
    public constructor(address: string | URL, protocols?: string | string[]) {
      super(validatePublicRelayAddress(address), protocols, {
        followRedirects: false,
        handshakeTimeout: CONNECTION_TIMEOUT_MS,
        lookup: createPublicLookup(resolver),
        maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
      });
      if (typeof this.on === "function") {
        this.on("error", () => undefined);
      }
    }
  }
  return PublicRelayWebSocket as typeof WebSocket;
}

function createRelayPool(resolver: HostnameResolver): RelayPoolLike {
  useWebSocketImplementation(createPublicWebSocketImplementation(resolver));
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
  private readonly subscriptionRegistrations = new Map<number, SubscriptionRegistration>();
  private readonly liveSubscriptions = new Map<string, Map<number, RelaySubscriptionLike>>();
  private readonly pendingTasks = new Set<Promise<unknown>>();
  private readonly temporaryRelayReferences = new Map<string, number>();
  private readonly inFlightRelayPublishes = new WeakMap<
    RelayLike,
    Map<string, Promise<string>>
  >();
  private pool: RelayPoolLike | null = null;
  private active = false;
  private generation = 0;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private nextSubscriptionId = 1;

  public constructor(
    relays: string[],
    poolFactory?: RelayPoolFactory,
    hostnameResolver: HostnameResolver = resolveHostname,
  ) {
    this.relays = [...new Set(relays)];
    this.poolFactory = poolFactory ?? (() => createRelayPool(hostnameResolver));

    for (const url of this.relays) {
      this.statuses.set(url, { url, state: "disconnected", reconnectAttempts: 0 });
    }
  }

  public getRelayStatuses(): RelayConnectionStatus[] {
    return this.relays.map((url) => ({ ...this.getStatus(url) }));
  }

  public registerSubscription(filter: Filter, handler: RelayEventHandler): () => void {
    const registration: SubscriptionRegistration = {
      id: this.nextSubscriptionId++,
      filter,
      handler,
    };
    this.subscriptionRegistrations.set(registration.id, registration);

    if (this.active) {
      for (const [url, relay] of this.activeRelays) {
        this.attachSubscription(url, relay, registration, this.generation);
      }
    }

    return () => {
      if (!this.subscriptionRegistrations.delete(registration.id)) {
        return;
      }
      for (const subscriptions of this.liveSubscriptions.values()) {
        try {
          subscriptions.get(registration.id)?.close("subscription disposed");
        } catch {
          // A local subscription cleanup failure must not prevent disposing the registration.
        }
        subscriptions.delete(registration.id);
      }
    };
  }

  public publish(event: NostrEvent): Promise<void> {
    if (!this.active) {
      return Promise.reject(new Error(RELAY_PUBLICATION_FAILED));
    }

    return this.trackTask(this.publishToActiveRelays(event));
  }

  public query(filter: Filter, timeoutMs = CONNECTION_TIMEOUT_MS): Promise<NostrEvent[]> {
    if (!this.active) {
      return Promise.reject(new Error(RELAY_QUERY_FAILED));
    }

    return this.trackTask(this.queryActiveRelays(filter, timeoutMs));
  }

  public publishToRelays(event: NostrEvent, relayUrls: string[]): Promise<void> {
    if (!this.active || relayUrls.length === 0) {
      return Promise.reject(new Error(RELAY_PUBLICATION_FAILED));
    }

    return this.trackTask(this.publishToRelayUrls(event, [...new Set(relayUrls)]));
  }

  public async addRelays(relayUrls: string[]): Promise<void> {
    const validated = [...new Set(relayUrls)].map((url) => {
      validatePublicRelayAddress(url);
      return url;
    });
    const additions = validated.filter((url) => !this.relays.includes(url));
    if (this.relays.length + additions.length > MAX_PERSISTENT_RELAY_COUNT) {
      throw new Error("Persistent relay limit exceeded");
    }
    for (const url of additions) {
      this.relays.push(url);
      this.statuses.set(url, {
        url,
        state: this.active ? "connecting" : "disconnected",
        reconnectAttempts: 0,
      });
    }
    if (!this.active || additions.length === 0) return;
    const generation = this.generation;
    await Promise.allSettled(additions.map((url) => this.connectRelay(url, generation)));
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
        try {
          poolCloseHandler?.();
        } catch {
          // Keep an upstream cleanup error from escaping the WebSocket close callback.
        } finally {
          this.handleRelayClose(url, relay, generation);
        }
      };
      try {
        for (const registration of this.subscriptionRegistrations.values()) {
          this.attachSubscription(url, relay, registration, generation);
        }
      } catch (error) {
        this.closeRelaySubscriptions(url);
        try {
          pool.close([url]);
        } catch {
          // The connection attempt still fails and enters the managed retry path below.
        }
        throw error;
      }
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

    this.closeRelaySubscriptions(url);
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

  private attachSubscription(
    url: string,
    relay: RelayLike,
    registration: SubscriptionRegistration,
    generation: number,
  ): void {
    if (!this.isActiveGeneration(generation)) {
      return;
    }

    let relaySubscriptions = this.liveSubscriptions.get(url);
    if (!relaySubscriptions) {
      relaySubscriptions = new Map();
      this.liveSubscriptions.set(url, relaySubscriptions);
    }
    if (relaySubscriptions.has(registration.id)) {
      return;
    }

    const subscription = relay.subscribe([registration.filter], {
      onevent: (event) => {
        if (!this.isActiveGeneration(generation)) {
          return;
        }
        const handlerTask = Promise.resolve()
          .then(() => registration.handler(event))
          .then(() => undefined)
          .catch(() => undefined);
        this.trackTask(handlerTask);
      },
    });
    relaySubscriptions.set(registration.id, subscription);
  }

  private closeRelaySubscriptions(url: string): void {
    const subscriptions = this.liveSubscriptions.get(url);
    if (!subscriptions) {
      return;
    }
    for (const subscription of subscriptions.values()) {
      try {
        subscription.close("relay disconnected");
      } catch {
        // Continue closing the remaining subscriptions and the owning relay pool.
      }
    }
    this.liveSubscriptions.delete(url);
  }

  private closeAllSubscriptions(): void {
    for (const url of this.liveSubscriptions.keys()) {
      this.closeRelaySubscriptions(url);
    }
  }

  private async publishToActiveRelays(event: NostrEvent): Promise<void> {
    const relays = [...this.activeRelays.values()];
    if (relays.length === 0) {
      throw new Error(RELAY_PUBLICATION_FAILED);
    }

    const results = await Promise.allSettled(
      relays.map((relay) => this.publishWithTimeout(relay, event)),
    );
    if (!results.some((result) => result.status === "fulfilled")) {
      throw new Error(RELAY_PUBLICATION_FAILED);
    }
  }

  private async queryActiveRelays(filter: Filter, timeoutMs: number): Promise<NostrEvent[]> {
    const relays = [...this.activeRelays.values()];
    if (relays.length === 0) {
      throw new Error(RELAY_QUERY_FAILED);
    }

    const results = await Promise.all(
      relays.map(
        (relay) =>
          new Promise<NostrEvent[]>((resolve) => {
            const events: NostrEvent[] = [];
            let settled = false;
            let subscription: RelaySubscriptionLike | null = null;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              try {
                subscription?.close("query complete");
              } catch {
                // Query results remain usable when local cleanup fails.
              }
              resolve(events);
            };
            const timeout = setTimeout(finish, timeoutMs);
            timeout.unref?.();
            try {
              subscription = relay.subscribe([filter], {
                onevent: (event) => {
                  if (events.length < MAX_QUERY_EVENTS_PER_RELAY) events.push(event);
                },
                oneose: finish,
              });
              if (settled) {
                subscription.close("query complete");
              }
            } catch {
              finish();
            }
          }),
      ),
    );

    const unique = new Map<string, NostrEvent>();
    for (const event of results.flat()) unique.set(event.id, event);
    return [...unique.values()];
  }

  private async publishToRelayUrls(event: NostrEvent, relayUrls: string[]): Promise<void> {
    const pool = this.pool;
    if (!pool) throw new Error(RELAY_PUBLICATION_FAILED);

    const results = await Promise.allSettled(
      relayUrls.map(async (url) => {
        const existing = this.findActiveRelay(url);
        if (existing) return this.publishWithTimeout(existing, event);

        this.retainTemporaryRelay(url);
        try {
          const relay = await pool.ensureRelay(url, {
            connectionTimeout: CONNECTION_TIMEOUT_MS,
          });
          return await this.publishWithTimeout(relay, event);
        } finally {
          this.releaseTemporaryRelay(url, pool);
        }
      }),
    );
    if (!results.some((result) => result.status === "fulfilled")) {
      throw new Error(RELAY_PUBLICATION_FAILED);
    }
  }

  private findActiveRelay(url: string): RelayLike | undefined {
    const exact = this.activeRelays.get(url);
    if (exact) return exact;

    let canonicalTarget: string;
    try {
      canonicalTarget = new URL(url).toString();
    } catch {
      return undefined;
    }
    for (const [activeUrl, relay] of this.activeRelays) {
      try {
        if (new URL(activeUrl).toString() === canonicalTarget) return relay;
      } catch {
        // Configured relay validation belongs to the caller; skip malformed keys here.
      }
    }
    return undefined;
  }

  private retainTemporaryRelay(url: string): void {
    this.temporaryRelayReferences.set(
      url,
      (this.temporaryRelayReferences.get(url) ?? 0) + 1,
    );
  }

  private releaseTemporaryRelay(url: string, pool: RelayPoolLike): void {
    const remaining = (this.temporaryRelayReferences.get(url) ?? 1) - 1;
    if (remaining > 0) {
      this.temporaryRelayReferences.set(url, remaining);
      return;
    }
    this.temporaryRelayReferences.delete(url);
    try {
      pool.close([url]);
    } catch {
      // Retain the URL so a later publication or stop() retries local cleanup.
      this.temporaryRelayReferences.set(url, 0);
    }
  }

  private publishWithTimeout(relay: RelayLike, event: NostrEvent): Promise<string> {
    let relayInFlight = this.inFlightRelayPublishes.get(relay);
    const existing = relayInFlight?.get(event.id);
    if (existing) {
      return existing;
    }
    if (!relayInFlight) {
      relayInFlight = new Map();
      this.inFlightRelayPublishes.set(relay, relayInFlight);
    }
    const publishPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(RELAY_PUBLICATION_FAILED)),
        PUBLICATION_TIMEOUT_MS,
      );
      timeout.unref?.();
      Promise.resolve()
        .then(() => relay.publish(event))
        .then(
          (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          () => {
            clearTimeout(timeout);
            reject(new Error(RELAY_PUBLICATION_FAILED));
          },
        );
    }).finally(() => {
      relayInFlight?.delete(event.id);
    });
    relayInFlight.set(event.id, publishPromise);
    return publishPromise;
  }

  private trackTask<T>(task: Promise<T>): Promise<T> {
    this.pendingTasks.add(task);
    const clearTask = () => {
      this.pendingTasks.delete(task);
    };
    void task.then(clearTask, clearTask);
    return task;
  }

  private async drainTasksBeforeClose(
    connectionPromises: Array<Promise<void>>,
    startPromise: Promise<void> | null,
  ): Promise<void> {
    await Promise.allSettled([
      ...connectionPromises,
      ...(startPromise ? [startPromise] : []),
    ]);
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks]);
    }
  }

  private async stopLifecycle(): Promise<void> {
    this.active = false;
    this.generation += 1;

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.closeAllSubscriptions();

    const pool = this.pool;
    const startPromise = this.startPromise;
    const connectionPromises = [...this.connectionPromises.values()];
    let closeError: unknown;
    for (const controller of this.connectionControllers.values()) {
      controller.abort();
    }
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.drainTasksBeforeClose(connectionPromises, startPromise),
        new Promise<void>((resolve) => {
          drainTimeout = setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS);
          drainTimeout.unref?.();
        }),
      ]);
    } finally {
      if (drainTimeout) {
        clearTimeout(drainTimeout);
      }
    }
    try {
      pool?.close([
        ...new Set([...this.relays, ...this.temporaryRelayReferences.keys()]),
      ]);
    } catch (error) {
      closeError = error;
    }

    this.activeRelays.clear();
    this.connectionControllers.clear();
    this.connectionPromises.clear();
    this.pendingTasks.clear();
    this.temporaryRelayReferences.clear();
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
