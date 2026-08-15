# Issue #6 Implementation Plan: End-to-End E2EE `/ping` and `/info` Nostr Commands

## Source and product context

- Delivery issue: [#6 — Slice 5: End-to-End E2EE `/ping` & `/info` Nostr Commands](https://github.com/Tunnelsats/nostr-community-bot/issues/6)
- Parent PRD: [#1 — Armada (Nostr) Community Bot Integration & Dual-Transport Architecture](https://github.com/Tunnelsats/nostr-community-bot/issues/1)
- Prerequisite: [#5 — Slice 4: Nostr Transport Adapter & Dual-Boot Init](https://github.com/Tunnelsats/nostr-community-bot/issues/5), closed and present on `Tunnelsats/Tunnel-Bot` `main`
- Target application: private repository [`Tunnelsats/Tunnel-Bot`](https://github.com/Tunnelsats/Tunnel-Bot)
- Repository guidance reviewed: [`AGENTS.md`](../AGENTS.md), [`DEVELOPING.md`](../DEVELOPING.md), and the repository `tdd-bot` skill

The parent PRD defines Slice 5 as the first user-visible use of the dual-transport foundation: a Nostr user sends `/ping <pubkey>` or `/info <pubkey>` in an encrypted NIP-17/NIP-59 direct message and receives an encrypted diagnostic response. Issue #5 deliberately delivered lifecycle only and left command registration to this slice.

This planning document belongs in `nostr-community-bot` because that repository tracks the roadmap issue. The implementation itself is expected in `Tunnel-Bot`; the generic library already supplies the encrypted command registry and must not acquire TunnelSats-specific LND or gossip dependencies.

## Current-state findings

### `nostr-community-bot`

- `NostrCommunityBot.registerCommand(name, handler)` registers typed command handlers before or after construction.
- A valid bot-addressed NIP-59 `kind:1059` gift wrap is decrypted and strictly validated through its `kind:13` seal and `kind:14` rumor before command dispatch.
- `CommandContext.senderPubkey` is the authenticated rumor author, `args` contains parsed command arguments, and `reply()` creates and publishes a fresh encrypted NIP-17 response linked to the inbound rumor.
- Cross-relay duplicates, malformed envelopes, handler rejection isolation, encrypted replies, and lifecycle shutdown already have upstream tests.
- No upstream code change is required unless implementation discovers a missing public contract; application logic must not reach into relay or encryption internals.

### `Tunnel-Bot`

- `src/transports/nostr-adapter.ts` constructs and starts the engine, but its narrow `NostrBotEngine` interface exposes only lifecycle/status methods. It does not expose `registerCommand`, and no commands are registered.
- `src/services/ping-service.ts` owns LND peer-connect latency measurement. Its `pingNode()` input is a full `pubkey@host:port` socket, while issue #6 specifies a pubkey-only Nostr command.
- `src/services/gossip-service.ts` validates a 66-character compressed Lightning pubkey, reads announced sockets from local LND gossip, and falls back to mempool.space. It currently has no dedicated test file.
- Telegram's `src/actions/ping.ts` and `src/actions/info.ts` mix service calls with Telegraf contexts, HTML, inline keyboards, and Telegram chat/session state. Nostr handlers must reuse the services, not emulate a Telegraf `Context` or call the Telegram actions.
- The shared rate limiter accepts arbitrary namespaced identities and can safely isolate Nostr senders with `nostr:<authenticated-sender-pubkey>` keys.
- The application currently consumes a reviewed vendored build of `nostr-community-bot` at commit `eb5f095`. Its public engine already contains `registerCommand`; only the adapter's local interface omits it.

## Goals

1. Register `/ping` and `/info` on every enabled Nostr engine before relay event processing begins.
2. Accept exactly one normalized 66-character compressed Lightning node pubkey for each command and return a concise usage response for invalid input.
3. Make `/ping` discover an announced address, perform an LND connection probe through `ping-service.ts`, and return a plain-text latency result.
4. Make `/info` return node alias/channel metadata and announced clearnet/onion addresses through `gossip-service.ts`.
5. Rate-limit expensive Nostr ping probes by the authenticated Nostr sender without sharing quota with Telegram identities.
6. Ensure every acknowledgement, success, validation failure, rate-limit response, and service failure is sent through `CommandContext.reply()` and is therefore NIP-17 encrypted.
7. Preserve Telegram behavior, Nostr/Telegram concurrent startup, graceful shutdown, and secret-key hygiene.

## Non-goals

- `/tunnelsats`, `/link`, subscription alerts, Armada channel commands, or NIP-29 group behavior (later roadmap slices).
- Changes to Telegram command output, callback buttons, or discovery sessions.
- New relay pools, direct NIP-17 event construction, recipient relay discovery, or changes to cryptographic validation in `nostr-community-bot`.
- Ping-by-explicit-socket syntax for the Nostr handler. Issue #6 promises `/ping <pubkey>`; broadening the public command grammar should be a separate product decision.
- Persisted/distributed rate limits. This slice uses the application's existing in-memory limiter and documents its single-process limitation.

## Command contract

Nostr messages are plain text. Do not reuse Telegram HTML tags, inline keyboards, URL encoding, or Telegraf-specific formatting.

### `/info <pubkey>`

1. Require exactly one argument matching `/^[0-9a-fA-F]{66}$/` and normalize it to lowercase.
2. Call `lookupNodeAddresses(pubkey)`.
3. On success, reply with a bounded plain-text summary containing the alias (or `Unknown`), channel count (or `N/A`), and a stable deduplicated list of announced sockets labelled `Clearnet` or `Tor`.
4. On an empty/not-found result, return the service's safe user-facing failure category without raw LND, HTTP, or stack-trace details.

Example shape:

```text
Lightning node info
Alias: Example Node
Channels: 42
Addresses:
- Clearnet: node.example:9735
- Tor: example.onion:9735

Note: gossip data may be out of date.
```

Cap the number of rendered addresses and the final response length with named constants. Report how many additional addresses were omitted. This prevents unexpectedly large encrypted replies and keeps client rendering predictable.

### `/ping <pubkey>`

1. Apply the same exact argument validation and normalization.
2. Reject a duplicate in-flight probe for the same target pubkey before consuming sender quota. This prevents overlapping LND `addPeer`/`removePeer` operations for one node.
3. Check the existing rate limiter with `nostr:${ctx.senderPubkey}`. If denied, reply with the existing retry-after semantics and do not call gossip or LND. If allowed, record the request synchronously in the same JavaScript turn, with no `await` between checking and recording. This reservation must happen before gossip lookup or an encrypted acknowledgement so concurrent commands from one sender cannot pass against the same quota snapshot.
4. Call `lookupNodeAddresses(pubkey)` to resolve announced sockets. Deduplicate them and select one deterministically: prefer the first clearnet address, otherwise use the first onion address. The reserved quota remains consumed if lookup finds no address or fails, because the command has already admitted network work.
5. Send a short encrypted acknowledgement naming only the public Lightning node key and selected address type.
6. Construct `${pubkey}@${selectedAddress.socket}` and call `pingNode()` from `ping-service.ts`.
7. Return a final encrypted plain-text result containing success/failure, measured latency when available, safe alias/channel values, selected address type/socket, the existing probe disclaimer, and the deployment's single-region latency caveat.

The deterministic single-address rule keeps one command within one rate-limit unit and avoids an unbounded sequence of 20/45-second probes. If product requirements later demand trying every announced socket, add an explicit command option, total deadline, probe cap, and per-address accounting rather than silently expanding this slice.

## Proposed design

### 1. Add transport-neutral Nostr node handlers in `Tunnel-Bot`

Create `src/transports/nostr-node-commands.ts` (or an equivalent application command module) rather than adding business logic directly to the adapter. Define narrow local types that match the upstream public contract without importing relay internals:

```ts
interface NostrCommandContext {
  args: string[];
  senderPubkey: string;
  reply(message: string): Promise<void>;
}

type NostrCommandHandler = (context: NostrCommandContext) => Promise<void> | void;

interface NostrCommandRegistrar {
  registerCommand(name: string, handler: NostrCommandHandler): unknown;
}
```

Export `registerNostrNodeCommands(engine, dependencies?)`. Production dependencies should be the existing `lookupNodeAddresses`, `pingNode`, `checkRateLimit`, and `recordRequest` functions; tests inject typed fakes. Registration must be synchronous and complete before `engine.start()` can subscribe and deliver events.

Keep shared pure helpers in this module or a small adjacent formatter module:

- exact argument parsing and lowercase normalization;
- stable address deduplication and clearnet-first selection;
- bounded `/info` formatting;
- success/failure `/ping` formatting;
- conversion of retry milliseconds to whole seconds.

The handlers should consume service result objects rather than throw for expected invalid/not-found/connectivity outcomes. Catch unexpected dependency errors at the handler boundary, send a generic encrypted failure when possible, and let neither raw exception text nor decrypted message content enter logs.

### 2. Extend the Slice 4 adapter seam

Extend `NostrBotEngine` in `src/transports/nostr-adapter.ts` with the typed `registerCommand()` method. After constructing the engine and validating the optional configured npub, call `registerNostrNodeCommands(engine)` before returning `NostrTransportAdapter`.

Keep the lifecycle interface returned to `server.ts` unchanged (`start()`/`stop()` only). The runtime coordinator should not know about commands, LND services, or encryption. Do not expose the engine globally or add registration after `TunnelBotRuntime.start()`; doing so creates a window in which an encrypted command can arrive before handlers exist.

The test module loader's fake class must implement `registerCommand` and record registrations. Assert exact lower-case names and one registration per engine construction. Disabled mode must still avoid importing the engine and command dependencies with side effects.

### 3. Reuse and harden service boundaries

Keep LND connection mechanics in `ping-service.ts` and gossip/fallback mechanics in `gossip-service.ts`. Do not duplicate `getNode`, `addPeer`, `removePeer`, timeout, or mempool.space logic in the Nostr layer.

Before relying on these services from a second transport, add missing deterministic coverage:

- `gossip-service.test.ts`: invalid pubkey; LND success with zero/one/multiple sockets; lowercase public key; local gossip failure/empty sockets falling back to mempool.space; malformed/non-OK/empty fallback responses; safe terminal failure.
- `ping-service.test.ts`: successful add/get/remove sequence and latency; clearnet/onion timeout choice; add failure and timeout mapping; cleanup on success/failure; sanitized returned errors.

Use Jest fake timers or injected clocks for latency/timeout behavior, and mock LND plus `fetch`; unit tests must never contact a real Lightning node or mempool.space.

If tests expose unsafe or unstable service behavior, refactor behind typed dependency injection while preserving the existing Telegram contract. Do not use `any`, and validate remote JSON from `unknown` before property access.

### 4. Layer encrypted-DM evidence correctly

Use three evidence layers instead of retesting cryptography in every handler unit test:

1. Handler unit tests invoke registered functions with a typed context and a `reply` spy, proving service routing, validation, rate limiting, and exact response text.
2. Adapter integration tests prove both handlers are registered before `start()` and that the reply function supplied by the engine is awaited for acknowledgements and final results.
3. A local/staging E2EE round trip uses a disposable sender key to send real NIP-17 gift wraps through a test relay, exercises mocked/staging LND and gossip outcomes, captures the bot's `kind:1059` replies, decrypts them with the sender key, and asserts no response plaintext appears in the outer events.

Automated CI must not depend on a public Nostr relay, public mempool.space, or a live LND node. If a hermetic local relay harness is added, keep its server bound to loopback on an ephemeral port and close every socket in `afterAll`. Otherwise retain the E2EE round trip as a documented staging gate and rely on the upstream deterministic NIP-17 tests plus the application handler/registration tests in CI.

## TDD implementation sequence

Follow Red–Green–Refactor for each cycle. Run the focused Jest file after adding each test and observe the intended failure before changing production code.

### Cycle 1: Command registration and input contract

**Red**

Add `src/transports/nostr-node-commands.test.ts` and extend `nostr-adapter.test.ts` to cover:

- exact one-time registration of `ping` and `info` before engine start;
- disabled Nostr mode performs no registration;
- missing, extra, short, long, non-hex, and uncompressed pubkeys return usage without invoking services;
- uppercase valid pubkeys are normalized to lowercase;
- every response awaits `ctx.reply()` and no Telegram method is required.

**Green**

- Add the handler module, typed registrar/context/dependency interfaces, and input parser.
- Extend the adapter's engine interface and register the handlers during construction.

**Refactor**

- Centralize shared validation/usage strings and remove duplication without moving business logic into `server.ts`.

### Cycle 2: `/info` gossip results

**Red**

Cover:

- the normalized pubkey is passed once to `lookupNodeAddresses()`;
- alias, channel count, clearnet sockets, and onion sockets are rendered as bounded plain text;
- duplicate sockets are removed in stable order;
- absent optional metadata uses explicit fallbacks;
- empty/not-found and thrown dependency failures yield safe replies;
- address/response caps report omitted entries and prevent oversized output.

Add the missing `gossip-service.test.ts` cases described above.

**Green**

- Implement the `/info` handler and pure formatter.
- Make only the minimum service hardening changes exposed by the new tests.

**Refactor**

- Share address normalization/classification helpers with `/ping` while keeping Telegram formatting unchanged.

### Cycle 3: `/ping` discovery, rate limiting, and LND probe

**Red**

Cover:

- rate-limit identity is `nostr:<authenticated sender pubkey>`, never the gift-wrap pubkey or Lightning target;
- a denied request returns retry timing and calls neither gossip nor `pingNode()`;
- address selection is stable, prefers clearnet, and falls back to onion;
- duplicate in-flight probes for the same target return a busy response without consuming quota;
- an allowed request is recorded synchronously before the first awaited gossip/reply operation;
- overlapping commands from the same sender cannot over-admit against one quota snapshot;
- no address and gossip failure produce safe replies after consuming the reserved request;
- `pingNode()` receives the exact normalized `pubkey@socket`;
- success formats latency/alias/channels/address type and the probe disclaimer;
- timeout/connect failure and unexpected throw produce sanitized encrypted responses;
- one invocation runs at most one LND probe.

Expand `ping-service.test.ts` to cover LND call ordering, timeout selection, cleanup, and result mapping.

**Green**

- Implement deterministic selection, synchronous quota reservation, acknowledgement, probe, and final formatting.

**Refactor**

- Keep sequencing explicit and avoid truthiness bugs for valid zero latency or zero channel counts.

### Cycle 4: Adapter lifecycle and encrypted integration

**Red**

Extend adapter/runtime coverage to prove:

- handlers exist before `engine.start()` is invoked;
- repeated transport `start()` does not register duplicates;
- a handler/reply failure is isolated by the upstream engine and does not stop later commands;
- shutdown while a probe is in flight stops new encrypted ingress and does not publish through a stopped engine;
- Telegram-only and dual-transport startup behavior remains unchanged.

Add the hermetic or staging E2EE scenario for both commands:

- wrap `/info <pubkey>` and `/ping <pubkey>` with a disposable sender key;
- deliver each as a bot-addressed `kind:1059` event;
- assert mocked/staging gossip and ping services receive the expected normalized inputs;
- decrypt bot replies and assert formatted content and reply linkage;
- assert outer events contain neither command text nor response text.

**Green**

- Complete adapter wiring and any bounded in-flight test coordination required at the application boundary.

**Refactor**

- Confirm the application owns service behavior, the library owns encryption/relay behavior, and the runtime owns lifecycle only.

### Cycle 5: Documentation and regression coverage

- Document the two Nostr DM commands, exact pubkey syntax, selected-address rule, rate limit, encrypted-response behavior, and relay-routing limitation in `Tunnel-Bot` operator/user documentation.
- Document that `NOSTR_BOT_NSEC` remains secret and that encrypted DM plaintext, sender identity, and raw events must not be logged.
- Add the command E2EE smoke procedure to deployment guidance, including disposable test keys and cleanup.
- Keep the full Telegram test suite as regression coverage; no Telegram command output should change in this slice.

## Expected implementation files in `Tunnel-Bot`

| File | Change |
| --- | --- |
| `src/transports/nostr-node-commands.ts` | Add typed `/ping` and `/info` handlers, validation, address selection, formatting, and dependency seams. |
| `src/transports/nostr-node-commands.test.ts` | Add command-level Red–Green coverage with typed context/service fakes. |
| `src/transports/nostr-adapter.ts` | Expose `registerCommand` on the narrow engine interface and register both handlers before start. |
| `src/transports/nostr-adapter.test.ts` | Verify registration order/count, disabled behavior, and adapter lifecycle regression cases. |
| `src/services/gossip-service.test.ts` | Add missing deterministic LND/fallback/validation tests. |
| `src/services/ping-service.test.ts` | Expand beyond socket parsing to LND probe, timeout, cleanup, and safe-error behavior. |
| `src/services/gossip-service.ts` | Apply only test-driven validation/error hardening needed for reuse. |
| `src/services/ping-service.ts` | Apply only test-driven dependency/cleanup hardening needed for reuse. |
| `src/server.test.ts` | Retain dual-transport startup/shutdown regression coverage if adapter wiring affects the runtime seam. |
| `README.md` and/or `docs/deploy_setup_guide.md` | Document Nostr command use, operational smoke test, privacy, and rollout. |

No source change is expected in `nostr-community-bot`. No new production dependency should be required. If a local relay test harness requires a package, justify it separately, pin it in the lockfile, and retain the zero-vulnerability gate.

## Acceptance-criteria traceability

| Issue #6 acceptance criterion | Planned evidence |
| --- | --- |
| `/ping <pubkey>` triggers node ping via LND and returns formatted latency response | Handler tests prove normalized gossip discovery, deterministic socket selection, exact `pingNode()` input, rate limiting, and formatted success/failure. Service tests prove the LND add/get/remove and latency path. The E2EE scenario decrypts the final response. |
| `/info <pubkey>` returns announced node addresses from gossip | Handler tests prove `lookupNodeAddresses()` routing and bounded clearnet/onion output. Gossip tests prove LND and fallback result mapping. The E2EE scenario decrypts the address response. |
| Responses are delivered via NIP-17 encrypted Nostr DMs | Adapter tests prove use of the engine-supplied `ctx.reply`; upstream tests prove that closure emits fresh NIP-17/NIP-59 wraps; the E2EE round trip verifies decryptability, reply linkage, and absence of plaintext in outer events. |

## Verification gates

Run focused tests throughout the TDD cycles, then all mandatory gates in each repository changed.

For `Tunnel-Bot`:

```bash
npm test -- --runInBand
npm run lint
npm run build
npm audit
npm run smoke:nostr
```

For `nostr-community-bot`, only if its source or vendored artifact changes:

```bash
npm test
npm run lint
npm run build
npm audit
```

`npm audit` must report zero vulnerabilities. Do not waive scanner findings. Unit and CI tests must use mocked services or a loopback relay; public infrastructure may supplement but never replace deterministic tests.

## Rollout and observability

1. Deploy with Nostr enabled in staging and LND credentials scoped exactly as the existing ping service requires.
2. Use a disposable Nostr sender key to run invalid-input, `/info`, successful `/ping`, failed `/ping`, and rate-limit scenarios.
3. Confirm responses decrypt only for the sender, outer events contain no plaintext, and no `nsec`, decrypted DM, authenticated sender pubkey, or raw inner event appears in logs.
4. Confirm Telegram `/ping` and `/info`, webhook health, Nostr reconnect, and `SIGTERM` shutdown still work.
5. Enable production without changing the established `ENABLE_NOSTR` rollback switch. Monitor command counts, safe outcome categories, rate-limit denials, service latency, and relay publication failures without attaching identities or plaintext.
6. Roll back by disabling Nostr and restarting; this slice has no schema migration or persisted state.

## Risks and mitigations

- **Transport coupling:** calling Telegraf actions from Nostr would require fake chat contexts and could leak HTML. Use service-level functions plus Nostr-specific plain-text handlers.
- **Peer-operation races:** probing several addresses for the same pubkey concurrently can make `addPeer`/`removePeer` interfere. Select one address deterministically and run one probe per command.
- **Abuse of LND/network resources:** rate-limit by authenticated Nostr sender and synchronously reserve an allowed request before any awaited gossip/reply work. Cover concurrent commands so separate targets cannot over-admit against one quota snapshot.
- **False negatives from address choice:** expose the selected address in the response and document the one-address policy; add explicit multi-address behavior only with a bounded design.
- **Oversized gossip responses:** cap rendered addresses and response size, and report omissions.
- **Error/privacy leakage:** use fixed user-facing failure categories and never log nsec material, decrypted messages, raw events, or sender-command pairs.
- **Registration race:** register synchronously during adapter creation, before relay startup.
- **Cross-package regression:** keep the adapter's narrow typed contract, execute the existing built-import smoke test, and exercise a real encrypted round trip in staging or a hermetic relay harness.
- **External-test flakiness:** mock LND and HTTP in CI; never require public relay, mempool.space, or live Lightning availability for a passing suite.

## Definition of done

- Both handlers are registered exactly once before Nostr startup and remain absent when Nostr is disabled.
- Every acceptance criterion has deterministic automated evidence plus an encrypted round-trip smoke result.
- `/ping` performs at most one rate-limited LND probe and returns a formatted encrypted outcome.
- `/info` returns a bounded encrypted list of announced addresses.
- Telegram command behavior and dual-transport lifecycle remain unchanged.
- No secrets, decrypted messages, raw encrypted-event internals, or identity-linked command data appear in logs or committed fixtures.
- `npm test`, `npm run lint`, `npm run build`, `npm audit`, and the built Nostr import smoke check all pass, with zero audit vulnerabilities.
