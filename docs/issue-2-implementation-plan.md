# Issue #2 Implementation Plan: Live Nostr Relay Connection Pool

## Source and product context

- Child issue: [#2 — Slice 1: Live Nostr Relay Connection Pool](https://github.com/Tunnelsats/nostr-community-bot/issues/2)
- Parent PRD: [#1 — Armada (Nostr) Community Bot Integration & Dual-Transport Architecture](https://github.com/Tunnelsats/nostr-community-bot/issues/1)
- Repository guidance reviewed: [`AGENTS.md`](../AGENTS.md) and [`DEVELOPING.md`](../DEVELOPING.md)

The parent PRD establishes this package as the open-source Nostr transport engine used by the later E2EE DM, command, alerting, and Armada slices. Issue #2 is the first transport slice and has no blockers. It must give those later slices a durable set of live relay connections without implementing their subscriptions, encryption, commands, or Tunnel-Bot integration yet.

## Current state

- `NostrBotConfig.relays` already requires at least one relay URL, and `getRelays()` returns a copy.
- `NostrCommunityBot.start()` is an empty placeholder.
- There is no `stop()` API, pool instance, connection status model, reconnect policy, or timer cleanup.
- `nostr-tools` and the Node `ws` implementation are already dependencies; no dependency addition is expected.
- The lockfile currently resolves `nostr-tools` to 2.24.1. Its `SimplePool` exposes `ensureRelay()`, `close()`, and connection status helpers, while `useWebSocketImplementation()` supplies the Node WebSocket implementation.

## Goals

1. Connect concurrently to every configured relay when `start()` is called.
2. Track a separate, observable lifecycle state for every relay.
3. Retry initial connection failures and unexpected socket drops independently with bounded exponential backoff.
4. Make `start()` and `stop()` idempotent and safe when called concurrently or repeatedly.
5. Make `stop()` cancel pending retries and connection attempts, then close all sockets through the pool so the process can exit cleanly.
6. Keep all lifecycle behavior deterministic under unit tests without opening real network connections.

## Non-goals

- NIP-17/NIP-59 decryption, gift-wrap handling, or event subscriptions (parent roadmap slice 2).
- Concord V2 or NIP-29 event handling (later roadmap slices).
- Publishing events, command replies, or changes to `processMessage()`.
- Tunnel-Bot database or dual-transport work.
- Runtime relay add/remove APIs; issue #2 only covers the constructor-provided relay set.

## Proposed public contract

Add strong types in `src/types.ts` and export them through the existing `export *` in `src/index.ts`:

```ts
export type RelayConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface RelayConnectionStatus {
  url: string;
  state: RelayConnectionState;
  reconnectAttempts: number;
}
```

Add these methods to `NostrCommunityBot`:

```ts
public getRelayStatuses(): RelayConnectionStatus[];
public async start(): Promise<void>;
public async stop(): Promise<void>;
```

Contract details:

- Before the first start and after a completed stop, each relay is `disconnected` with zero reconnect attempts.
- The first attempt is `connecting`; retry windows and retry attempts remain `reconnecting` until a connection succeeds.
- A successful connection is `connected` and resets its retry counter.
- `getRelayStatuses()` returns copied snapshot objects in configured relay order so callers cannot mutate internal state.
- `start()` performs one initial attempt per relay concurrently and resolves after every initial attempt has either connected or entered the background retry loop. One unavailable relay does not prevent healthy relays or make the bot unusable.
- Calling `start()` while already starting or running does not create duplicate pools, sockets, or retry loops.
- `stop()` may be called before, during, or after `start()`. It is safe to call more than once, and a later `start()` can establish a fresh lifecycle.

Do not add `lastError` to the public status in this slice. It is not required by the issue and avoiding arbitrary transport errors in the status surface reduces accidental leakage. No key material, plaintext identity data, or full config object may be logged.

## Internal design

### 1. Add a relay lifecycle manager

Create `src/relay-connection-manager.ts` to keep socket/timer concerns out of the command engine. `NostrCommunityBot` owns one manager and delegates `start()`, `stop()`, and status snapshots to it.

The manager should:

- Configure `nostr-tools/pool` with the default import from `ws` via `useWebSocketImplementation(WebSocket)`.
- Construct `SimplePool` with ping support enabled so dead Node sockets are detected.
- Leave `SimplePool`'s built-in reconnect disabled and own reconnection explicitly. The locked library's reconnect delays are a fixed sequence rather than the issue's required exponential policy, and owning the policy also makes state tracking and shutdown cancellation deterministic.
- Retain a small internal `RelayPoolLike`/`RelayLike` interface and accept a pool factory in the manager constructor. Production uses `SimplePool`; unit tests supply fakes. This seam remains internal and is not exported from `src/index.ts`.
- Keep per-relay status, retry count, and at most one retry timer in maps keyed by the configured URL.
- Keep one lifecycle `AbortController` (or equivalent generation token) so results from an old/stopped run cannot update a restarted run.

### 2. Initial connection algorithm

For each relay, `start()` should:

1. Mark it `connecting`.
2. Call `pool.ensureRelay(url, { connectionTimeout: ... })`; use an internal finite timeout so an unreachable relay cannot leave `start()` pending forever.
3. On success, attach a close callback while preserving the pool's existing close callback, mark `connected`, and reset the retry counter.
4. On failure, do not throw the whole startup. If the lifecycle is still active, mark `reconnecting` and schedule that relay's first retry.
5. Await all initial outcomes with all-settled semantics.

Connection attempts for different relays must not serialize or share retry counters.

### 3. Exponential reconnect policy

Use a named internal policy rather than scattered literals:

```text
delay(attempt) = min(1_000 ms * 2^(attempt - 1), 30_000 ms)
```

This yields 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s for subsequent failures. The first retry has `reconnectAttempts === 1`. A successful reconnect resets the count to zero. Retries continue until success or `stop()`; there is no global retry limit because long relay outages are expected for a live bot.

For this slice, use deterministic delays without jitter so fake-timer tests can assert exact behavior. Jitter can be added later as an explicit configurable policy if deployment experience shows synchronized reconnects are a problem.

An unexpected relay close should call the preserved pool cleanup callback, then schedule exactly one reconnect. Guard against duplicate close/error notifications and stale timers by checking both the active lifecycle generation and the per-relay timer map.

### 4. Graceful shutdown

`stop()` should perform shutdown in this order:

1. Mark the lifecycle inactive before touching sockets so close callbacks cannot schedule new work.
2. Clear every pending reconnect timer.
3. Close the configured relays through `SimplePool.close(relays)` and abort/reject any in-flight connection attempt.
4. Await the in-flight startup/connection work settling as needed; do not leave unhandled promise rejections.
5. Clear internal attempt/timer references and set every relay status to `disconnected` with zero attempts.

The close path must also cover sockets still in the WebSocket `CONNECTING` state. Do not merely clear application maps, because that can leave a socket holding the Node process open.

## TDD implementation sequence

Follow the repository-mandated Red–Green–Refactor loop for each group below. Run the focused test after writing it and confirm that it fails for the intended missing behavior before adding production code.

### Cycle 1: Startup and status tracking

**Red**

Add `src/__tests__/relay-connection-manager.test.ts` with a typed fake pool/relay and fake timers. Cover:

- one `ensureRelay()` call for every configured URL;
- attempts begin concurrently rather than waiting for the previous relay;
- status transitions from `disconnected` to `connecting` to `connected`;
- a failed initial attempt becomes `reconnecting` without rejecting the entire `start()`;
- one relay failure does not change another connected relay;
- returned status snapshots cannot mutate manager state.

Extend `src/__tests__/bot.test.ts` to prove `NostrCommunityBot.start()` delegates to the lifecycle manager and exposes its status snapshot.

**Green**

- Add the status types.
- Add the manager with only initial connection/state behavior.
- Wire it into `NostrCommunityBot`.

**Refactor**

- Extract named timeout/backoff constants and typed internal pool interfaces.
- Remove duplicated state-update logic while keeping all tests green.

### Cycle 2: Socket-drop reconnects

**Red**

Using `vi.useFakeTimers()`, cover:

- an unexpected close moves only that relay to `reconnecting`;
- no reconnect occurs before 1 s and exactly one occurs at 1 s;
- consecutive failures retry at 1, 2, 4, 8, 16, and capped 30 second delays;
- reconnect success returns to `connected` and resets the attempt count;
- a later drop starts again at the 1 second delay;
- repeated close notifications cannot create parallel timers or connections.

**Green**

- Add per-relay timers/counters and the bounded exponential delay calculation.
- Chain the pool's existing relay close callback before scheduling application-level reconnection.

**Refactor**

- Centralize `connectRelay()`/`scheduleReconnect()` ownership so each relay can have only one in-flight attempt and one timer.

### Cycle 3: Idempotency and graceful stop

**Red**

Cover:

- two simultaneous `start()` calls share one startup operation and do not duplicate `ensureRelay()` calls;
- `stop()` closes every configured relay exactly once;
- `stop()` clears pending reconnect timers, and advancing fake time creates no new connections;
- `stop()` during an unresolved initial connection closes/aborts it and settles without an unhandled rejection;
- close callbacks caused by `stop()` do not schedule retries;
- repeated `stop()` is harmless;
- `start()` after `stop()` creates a fresh connection lifecycle.

Extend `src/__tests__/bot.test.ts` to assert the public `bot.stop()` delegation and idempotent lifecycle behavior.

**Green**

- Add lifecycle generation/abort handling, cached start/stop operations, timer cancellation, and pool close calls.
- Ensure all promise rejection paths are caught and converted into state/retry behavior only while the run is active.

**Refactor**

- Review race guards and remove any test-only behavior from the public API.
- Confirm no `any` is introduced in project-owned code.

### Cycle 4: Documentation and regression coverage

- Update `README.md` usage to show `await bot.start()`, status inspection, and `await bot.stop()` in a `finally` block or process-shutdown handler.
- Update `DEVELOPING.md`'s architecture notes with relay lifecycle ownership and the rule that later subscriptions reuse the manager-owned pool.
- Keep the existing command parsing and registration tests unchanged as regression coverage.

## Expected file changes

| File | Change |
| --- | --- |
| `src/types.ts` | Add exported relay state/status types. |
| `src/relay-connection-manager.ts` | Add pool setup, per-relay state, initial connects, retries, and shutdown. |
| `src/bot.ts` | Own/delegate to the manager; implement `start()`, `stop()`, and status access. |
| `src/__tests__/relay-connection-manager.test.ts` | Add deterministic lifecycle and backoff tests with typed fakes/fake timers. |
| `src/__tests__/bot.test.ts` | Add public API delegation/idempotency regression tests. |
| `README.md` | Document lifecycle usage and shutdown. |
| `DEVELOPING.md` | Document the new transport component and ownership boundary. |

No `package.json` or lockfile change should be necessary. If implementation reveals a dependency change is unavoidable, treat that as a separate reviewed step and retain the zero-vulnerability requirement.

## Acceptance criteria traceability

| Issue #2 criterion | Planned evidence |
| --- | --- |
| Bot connects to specified relays at startup | Concurrent-start tests assert one `ensureRelay()` call per configured URL and connected states for successful fakes. |
| Auto-reconnects on socket drop with exponential backoff | Fake-timer tests assert drop detection, exact 1/2/4/8/16/30-second retry schedule, cap, reset on success, and per-relay isolation. |
| Graceful shutdown closes all relay sockets cleanly | Stop tests assert all configured relays are closed, pending/in-flight work is cancelled, no retry occurs after stop, and repeated stop is safe. |

## Verification gates

After every Red–Green cycle, run the focused Vitest file and then the full suite. Before considering implementation complete, all repository gates must pass:

```bash
npm test
npm run lint
npm run build
npm audit
```

`npm audit` must report zero vulnerabilities. Do not waive scanner findings. Optionally run `npm run test:coverage` to inspect lifecycle branch coverage, but it does not replace the required commands.

Do not use public relay availability as automated CI evidence; those tests would be flaky and require network access. A manual smoke test against a disposable local WebSocket relay, followed by one public `wss://` relay if appropriate, may supplement but not replace the deterministic unit tests.

## Implementation risks and mitigations

- **Pool callback ownership:** `ensureRelay()` installs its own close callback. Preserve and invoke it before application handling so the pool does not retain a dead relay.
- **Reconnect implementation mismatch:** Do not enable `SimplePool`'s internal reconnect while also scheduling manager retries; two owners would create duplicate sockets and its locked delay sequence is not exponential.
- **Shutdown races:** Gate all async continuations and close callbacks on a lifecycle generation/active flag, and cancel both timers and connecting sockets.
- **Partial outages:** Never use fail-fast `Promise.all()` for relay startup. Healthy relays must remain usable while another retries.
- **Process leaks:** Tests must verify timer count/connection attempts after stop, and the implementation must call the pool close path rather than only clearing state.
- **Secret hygiene:** Relay lifecycle code needs URLs and transport errors only. It must never receive, stringify, or log the bot secret key.

## Definition of done

- Every acceptance criterion has a passing deterministic test.
- Each test was observed failing for the expected reason before its implementation was added.
- Public types and lifecycle behavior are documented.
- No later PRD slice has been pulled into this change.
- `npm test`, `npm run lint`, `npm run build`, and `npm audit` all pass, with zero audit vulnerabilities.
