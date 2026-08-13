# Issue #3 Implementation Plan: NIP-17 / NIP-59 E2EE Direct Messages

## Source and product context

- Parent PRD: [#1 — Armada (Nostr) Community Bot Integration & Dual-Transport Architecture](https://github.com/Tunnelsats/nostr-community-bot/issues/1)
- Child issue: [#3 — Slice 2: NIP-17 / NIP-59 E2EE DM Protocol](https://github.com/Tunnelsats/nostr-community-bot/issues/3)
- Blocker: [#2 — Slice 1: Live Nostr Relay Connection Pool](https://github.com/Tunnelsats/nostr-community-bot/issues/2), implemented on `main` by PR #23
- Repository guidance reviewed: [`AGENTS.md`](../AGENTS.md), [`DEVELOPING.md`](../DEVELOPING.md), and the repository `tdd-bot` skill
- Protocol references: [NIP-17 Private Direct Messages](https://github.com/nostr-protocol/nips/blob/master/17.md), [NIP-59 Gift Wrap](https://github.com/nostr-protocol/nips/blob/master/59.md), and [NIP-44 Encrypted Payloads](https://github.com/nostr-protocol/nips/blob/master/44.md)

The parent PRD makes this slice the encrypted transport foundation for the later Tunnel-Bot `/ping`, `/info`, `/tunnelsats`, `/link`, and alerting slices. This repository should own the Nostr protocol mechanics and expose the existing typed command context; Tunnel-Bot remains responsible for customer data, Wireguard linking, node diagnostics, subscriptions, and business-specific handlers.

## Current state

- `NostrCommunityBot` parses the configured `nsec`, derives the bot pubkey, registers command handlers, and can dispatch plaintext through `processMessage()`.
- `CommandContext` already contains `senderPubkey`, `eventId`, and an async `reply()` function. Tests inject the reply function directly; there is no encrypted transport-backed implementation yet.
- `RelayConnectionManager` owns the single `SimplePool`, opens configured relays, reconnects them independently, and closes sockets/timers on `stop()`.
- The relay abstraction currently exposes only `ensureRelay()`, `onclose`, and `close()`. It has no subscription or publishing seam, so issue #3 must extend the existing manager rather than create a second pool.
- There is no subscription for `kind:1059`, gift-wrap decryption, inner-event validation, inbound event deduplication, or outbound publication.
- The lockfile resolves `nostr-tools` to 2.24.1. It includes NIP-17/NIP-59 wrapping and NIP-44 primitives, but its `unwrapEvent()` helper decrypts directly to the rumor and does not itself enforce all protocol invariants. In particular, application code still needs to validate the outer recipient, seal kind/signature/tags, rumor hash/kind/recipient, and equality of the seal and rumor authors.
- No dependency addition should be needed.

## Protocol and scope decisions

The implementation should model the three protocol layers explicitly:

```text
kind 1059 gift wrap (signed by a random one-time key, p-tagged to bot)
  -> NIP-44 decrypt with bot secret key and wrapper pubkey
kind 13 seal (signed by the real sender, no tags)
  -> NIP-44 decrypt with bot secret key and seal pubkey
kind 14 rumor (unsigned DM carrying plaintext command and recipient p-tag)
```

For inbound messages, do not treat successful decryption as sufficient validation. Verify each layer before command dispatch, including the NIP-17 requirement that the seal author and rumor author match. This prevents a valid gift wrap from being used to impersonate a different rumor author.

For outbound replies, use the locked `nostr-tools` NIP-17 wrapping implementation so every response receives a new random wrapper key, a signed `kind:13` seal, randomized past timestamps for the public layers, and a `kind:1059` wrapper addressed to the sender. Publish through the existing manager-owned relay objects.

This slice uses the configured relay set for both listening and reply publication, matching the dependency on issue #2. Discovery and enforcement of a recipient's `kind:10050` preferred DM relay list is not specified by issue #3 and is a separate interoperability enhancement. Document that limitation clearly: full NIP-17 relay-routing compliance requires recipient relay discovery, even though the event encryption and addressing in this slice are NIP-17/NIP-59 compatible.

## Goals

1. Subscribe on every configured live relay for verified `kind:1059` events whose `p` tag targets the bot pubkey.
2. Reattach that subscription after a managed relay reconnects without creating duplicate subscriptions.
3. Unwrap and strictly validate the gift wrap, seal, and `kind:14` rumor using the bot secret key.
4. Dispatch the rumor's plaintext content through the existing command registry with the authenticated rumor author as `senderPubkey` and the rumor ID as `eventId`.
5. Make `ctx.reply(message)` create a NIP-17/NIP-59 response addressed to that sender, link it to the inbound rumor, and publish it to the configured connected relays.
6. Deduplicate the same gift wrap received from multiple relays or redelivered after reconnect.
7. Isolate malformed/unaddressed events and per-relay failures without leaking private keys, ciphertext, decrypted content, or user identity secrets.
8. Preserve the issue #2 lifecycle guarantees: one pool owner, idempotent start/stop, bounded reconnects, and no sockets, subscriptions, timers, or unhandled promises after stop.

## Non-goals

- Business commands or Tunnel-Bot database/backend behavior from parent roadmap slices 3–7.
- Concord V2 community events, NIP-29 groups, or public-channel command transport.
- Legacy NIP-04 direct messages.
- NIP-17 group conversations, `kind:15` file messages, reactions, edits, deletions, disappearing messages, or ephemeral `kind:21059` wraps.
- Sending a second encrypted copy to the bot itself for conversation-history recovery.
- Resolving a sender's `kind:10050` DM relay list, NIP-65 relay discovery, NIP-42 authentication, proof of work, or relay-specific spam policy.
- Durable message storage or replay history. The bot processes live relay deliveries only.
- Exposing the bot secret key or decrypted protocol structures as new public APIs.

## Proposed observable contract

### Inbound behavior

- `start()` first starts the relay manager, then ensures one persistent gift-wrap subscription definition is active for every connected relay with this filter:

  ```ts
  { kinds: [1059], "#p": [botPubkeyHex] }
  ```

- A relay that reconnects receives one fresh live subscription. Existing healthy relays are not resubscribed or interrupted.
- The same outer event ID is processed at most once across all configured relays and reconnects during a running bot lifecycle.
- Only a validated `kind:14` rumor addressed to the bot reaches command parsing. Unknown commands and non-command plaintext remain unhandled and produce no reply.
- `CommandContext.senderPubkey` is the validated rumor/seal author, never the random outer wrapper pubkey.
- `CommandContext.eventId` is the inner rumor ID, allowing a response to reference the actual private message rather than its relay-visible envelope.
- Protocol-invalid input is dropped without invoking a command handler. It must not crash the relay callback or reject `start()`.

### Reply and publication behavior

- For a relay-delivered DM, `ctx.reply(message)` creates a new NIP-17 `kind:14` rumor with:
  - plaintext `content` equal to `message`;
  - one `p` tag for the authenticated sender pubkey;
  - an `e` reply tag referencing the triggering rumor ID;
  - the bot pubkey as rumor/seal author;
  - a fresh random one-time wrapper key and a `kind:1059` wrapper `p`-tagged to the sender.
- The public gift-wrap event and tags must not contain the reply plaintext, bot secret key, or unencrypted inner structures.
- The manager attempts publication concurrently on every currently connected configured relay.
- `ctx.reply()` resolves when at least one relay acknowledges the event and rejects with a sanitized error when no relay is connected or every relay rejects it. A failed relay must not turn a successful delivery on another relay into an overall failure.
- Each call to `ctx.reply()` creates and publishes a fresh gift wrap. No encrypted event or ephemeral wrapper key is reused.

### Existing direct-dispatch API

Keep `processMessage(text, senderPubkey, eventId, replyFn?)` as the transport-independent/testing seam for compatibility. The encrypted `ctx.reply()` guarantee applies when this method is invoked from the validated gift-wrap path, which supplies the transport-backed reply closure. Existing consumers that call `processMessage()` directly may continue to inject their own reply function.

## Internal design

### 1. Add a strict NIP-17 DM protocol module

Create `src/nip17-dm.ts` and keep cryptographic parsing out of `bot.ts`. It should expose project-internal functions with strongly typed inputs/outputs, for example:

```ts
interface DirectMessageRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: 14;
  tags: string[][];
  content: string;
}

function unwrapDirectMessage(
  wrap: NostrEvent,
  recipientSecretKey: Uint8Array,
  recipientPubkey: string,
): DirectMessageRumor;

function createDirectMessageReply(
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  message: string,
  replyToEventId: string,
): NostrEvent;
```

Do not use `any` or unchecked type assertions on decrypted JSON. Parse JSON into `unknown`, then narrow it with explicit structural guards before passing it to `verifyEvent()`, `getEventHash()`, or command code.

Inbound validation order should reject as early and cheaply as practical:

1. Enforce an internal maximum encrypted-content length before invoking NIP-44 decryption; the locked NIP-44 type declarations explicitly require callers to bound payload size to prevent resource exhaustion.
2. Validate the outer event structure, `kind === 1059`, event ID/signature, and exactly one recipient `p` tag matching the bot pubkey.
3. Derive the NIP-44 conversation key from the bot secret key and the wrapper's ephemeral pubkey; decrypt and parse the seal.
4. Validate that the seal is a signed, valid `kind:13` event with an empty tag list.
5. Derive the second NIP-44 conversation key from the bot secret key and the seal author's pubkey; decrypt and parse the rumor.
6. Validate that the rumor is unsigned, is `kind:14`, has well-formed fields, has an ID equal to `getEventHash(rumor)`, and contains a `p` tag for the bot.
7. Require `seal.pubkey === rumor.pubkey`. Use that authenticated pubkey as the command sender.

Return a sanitized protocol error or result type that never embeds secret-key bytes, decrypted content, or complete raw events. The bot's relay callback may ignore protocol-invalid events, but it must catch all failures so they cannot become unhandled promise rejections.

For outbound responses, `createDirectMessageReply()` should delegate to `nip17.wrapEvent()` with a recipient descriptor and `replyTo` descriptor. Validate the reply input (non-empty recipient hex pubkey and string message) at the boundary, then return the signed wrapper event for publication.

### 2. Extend the existing relay manager instead of adding a pool

Expand the internal `RelayLike` and typed fake interfaces with only the relay operations required by this slice:

```ts
interface RelaySubscriptionLike {
  close(reason?: string): void;
}

interface RelayLike {
  onclose: (() => void) | null;
  subscribe(filters: Filter[], params: SubscriptionParams): RelaySubscriptionLike;
  publish(event: NostrEvent): Promise<string>;
}
```

Add internal manager methods for persistent subscriptions and publication. A persistent subscription registration should be stored independently from its per-relay live subscription handles:

- registering before `start()` records the filter and handler without opening a second connection;
- every successful initial connection attaches one handle for that relay/registration pair;
- reconnection replaces only the dropped relay's handle;
- repeated registration/start/reconnect callbacks cannot create duplicate live handles;
- `stop()` closes all live subscription handles before closing the pool, while retaining the registration needed for a later `start()`;
- a registration disposer, if added, removes its live handles and prevents reattachment.

Add a `publish(event)` method that snapshots the currently connected relay objects, calls their `publish()` operations concurrently, and applies the at-least-one-acknowledgement contract. Do not call `new SimplePool()` from `bot.ts`, and do not use a separate reconnect loop for subscriptions or writes.

The manager must track asynchronous subscription-handler tasks long enough to prevent unhandled rejections and to allow `stop()` to settle or safely detach them. It must mark the lifecycle inactive before closing subscriptions so close callbacks cannot schedule new work.

### 3. Wire the encrypted transport into `NostrCommunityBot`

Register the gift-wrap subscription exactly once for the bot instance. On each delivered event:

1. Check the bounded deduplication cache using the verified outer event ID.
2. Unwrap and validate the event with `unwrapDirectMessage()`.
3. Build a reply closure that calls `createDirectMessageReply()` with the bot secret, authenticated sender pubkey, response text, and inbound rumor ID, then calls the relay manager's `publish()`.
4. Pass the rumor content, sender pubkey, rumor ID, and reply closure to `processMessage()`.
5. Catch protocol, command-handler, and publication failures at the async relay callback boundary so later events continue to be processed.

Keep the secret key private and never pass it through `CommandContext`. Do not stringify `NostrBotConfig`, secret bytes, raw decrypted events, or message plaintext for logging.

Use a bounded insertion-ordered cache for processed outer event IDs rather than an unbounded `Set`. The capacity should be a named internal constant and tests should prove eviction is deterministic. Clear the cache on a fully completed `stop()` so a fresh run can replay events supplied by the relay if desired; within one run, duplicate delivery must remain suppressed.

### 4. Preserve lifecycle ordering and races

The bot lifecycle should have one clear order:

- Construction records the persistent subscription definition but performs no network or cryptographic work.
- `start()` activates the manager; subscription handles attach as each relay connects.
- A reconnect reuses the same subscription definition and deduplication cache.
- `stop()` disables new event dispatch, closes live subscription handles, closes/aborts the relay lifecycle, waits for tracked event tasks to settle safely, and clears per-run deduplication state.
- Concurrent/repeated `start()` and `stop()` retain issue #2's idempotency guarantees and never multiply subscription handles.

If an event arrives during shutdown, the active lifecycle generation must prevent it from invoking a command or publishing a reply after stop has begun.

## TDD implementation sequence

Follow the repository-mandated Red–Green–Refactor loop. For every cycle, write the focused failing tests first, run them, and confirm the failure is caused by missing behavior before changing production code.

### Cycle 1: Strict gift-wrap unwrapping

**Red**

Add `src/__tests__/nip17-dm.test.ts` using deterministic test keys and locally constructed NIP-17 events. Cover:

- a valid `kind:1059` event decrypts to the expected `kind:14` rumor;
- the returned sender is the seal/rumor author rather than the wrapper's ephemeral pubkey;
- the inner plaintext and rumor ID survive unwrapping;
- wrong outer kind, invalid outer signature/ID, missing/extra/wrong `p` tags, malformed or oversized ciphertext, and invalid JSON are rejected;
- a non-`kind:13` seal, non-empty seal tags, invalid seal signature, wrong rumor kind, malformed rumor, wrong rumor hash, a signed rumor, or missing bot `p` tag is rejected;
- a seal/rumor pubkey mismatch is rejected as an impersonation attempt;
- error messages/results do not contain the secret key or decrypted command text.

**Green**

- Add typed unknown-value guards and the two-stage NIP-44 decryptor.
- Enforce every wrapper, seal, and rumor invariant required for command dispatch.

**Refactor**

- Centralize event/tag guards and the payload-size constant.
- Confirm no project-owned `any` or unsafe secret-bearing error is introduced.

### Cycle 2: Persistent relay subscriptions and publication

**Red**

Extend `src/__tests__/relay-connection-manager.test.ts` typed fakes to cover:

- registering the gift-wrap filter before start attaches one subscription per successful configured relay;
- a failed relay does not affect healthy subscriptions;
- reconnecting a dropped relay closes/replaces only its subscription and does not duplicate healthy handles;
- concurrent/repeated `start()` calls do not multiply subscriptions;
- `stop()` closes all live subscriptions, prevents post-stop delivery, and a later start attaches fresh handles;
- publication fans out concurrently to connected relays;
- one acknowledgement plus one rejection resolves successfully;
- no connected relays or all rejected publications produce a sanitized rejection;
- stop waits for or safely isolates in-flight event-handler/publication promises with no unhandled rejection.

**Green**

- Extend the internal relay interfaces and production `SimplePool` adapter.
- Add persistent subscription bookkeeping, reconnect reattachment, publication fan-out, and shutdown cleanup.

**Refactor**

- Keep connection, subscription, and publication state keyed per relay with a single lifecycle-generation guard.
- Remove duplicated cleanup paths while retaining the issue #2 reconnect tests.

### Cycle 3: Encrypted inbound command dispatch

**Red**

Extend `src/__tests__/bot.test.ts` with a relay fake that can emit events. Cover:

- `start()` installs the exact `kind:1059`/`#p` filter for the bot pubkey;
- a valid encrypted `/ping arg` rumor invokes the registered handler with parsed args;
- `ctx.senderPubkey` is the authenticated rumor author and `ctx.eventId` is the rumor ID;
- non-command and unregistered-command rumors do not invoke handlers or publish;
- invalid, unaddressed, or unsupported encrypted events do not invoke handlers;
- the same wrapper emitted by two relays is processed once;
- deterministic cache eviction retains a fixed memory bound;
- an async handler rejection is isolated and a later valid event is still processed;
- an event delivered after shutdown begins cannot dispatch.

**Green**

- Register the subscription in `NostrCommunityBot` and route validated rumor content through `processMessage()`.
- Add the bounded per-run outer-event deduplication cache and track async event tasks.

**Refactor**

- Keep protocol parsing, command dispatch, and relay lifecycle responsibilities separated.
- Preserve the existing public direct-dispatch tests as compatibility coverage.

### Cycle 4: Encrypted `ctx.reply()`

**Red**

Add protocol and bot integration tests covering:

- calling `ctx.reply("Pong")` publishes a valid signed `kind:1059` event;
- the wrapper has one `p` tag for the original sender and uses a random wrapper pubkey rather than the bot pubkey;
- unwrapping the response with the recipient test key yields a `kind:14` rumor authored by the bot, with `content === "Pong"`, a recipient `p` tag, and an `e` reply tag for the inbound rumor ID;
- the wrapper content/tags do not reveal `Pong`, the bot secret, or serialized inner events;
- each of two replies creates a distinct wrapper event and ephemeral pubkey;
- one successful relay acknowledgement makes `ctx.reply()` resolve despite another relay failure;
- all-relay failure/no active relay makes `ctx.reply()` reject without leaking reply plaintext or keys;
- a reply racing with `stop()` cannot publish through a stale lifecycle.

**Green**

- Add the outbound NIP-17 helper using `nip17.wrapEvent()`.
- Inject the encrypted publish closure into the relay-delivered command context.

**Refactor**

- Centralize reply construction and sanitized publish errors.
- Verify that no wrapper/event/key object is cached or reused between replies.

### Cycle 5: Documentation and regression coverage

- Update `README.md` to describe live NIP-17 command handling, encrypted replies, the configured-relay routing behavior, clean shutdown, and the requirement to protect the bot `nsec`.
- Update `DEVELOPING.md` with the gift-wrap validation pipeline, the manager-owned subscription/publication boundary, reconnect resubscription, and why sender identity comes from the validated seal/rumor pair.
- Keep command parser, secret-key parsing, relay reconnection, and lifecycle tests as regression coverage.

## Expected file changes

| File | Change |
| --- | --- |
| `src/nip17-dm.ts` | Add bounded, strict gift-wrap/seal/rumor validation and outbound reply wrapping. |
| `src/types.ts` | Add only the explicit protocol/result/error types that must cross module boundaries; retain a typed `CommandContext`. |
| `src/relay-connection-manager.ts` | Add persistent per-relay subscriptions, reconnect reattachment, publish fan-out, and shutdown cleanup on the existing pool. |
| `src/bot.ts` | Subscribe for bot-addressed gift wraps, deduplicate/dispatch validated rumors, and inject encrypted reply publication. |
| `src/__tests__/nip17-dm.test.ts` | Add deterministic crypto/protocol validation and reply round-trip tests. |
| `src/__tests__/relay-connection-manager.test.ts` | Add subscription, resubscription, publishing, partial-failure, and cleanup tests with typed fakes. |
| `src/__tests__/bot.test.ts` | Add encrypted inbound dispatch, context identity, deduplication, reply, and lifecycle integration tests. |
| `README.md` | Document E2EE command/reply usage and configured-relay routing limitations. |
| `DEVELOPING.md` | Document protocol validation and transport ownership. |

`src/event-utils.ts`, `src/index.ts`, `package.json`, and `package-lock.json` should not require functional changes. If implementation reveals a dependency update is unavoidable, treat it as a separate reviewed change and retain the zero-vulnerability requirement.

## Acceptance criteria traceability

| Issue #3 criterion | Planned evidence |
| --- | --- |
| Kind 1059 gift wraps are unwrapped using bot secret key | Protocol round-trip tests decrypt a valid wrapper only with the configured bot key and reject invalid wrapper, seal, rumor, recipient, hash, signature, and author combinations. |
| Inner rumor content is parsed for commands | Bot integration tests emit an encrypted `kind:14` `/ping` rumor and assert the registered handler receives authenticated sender, inner event ID, command, and args exactly once. |
| `ctx.reply()` constructs and publishes gift-wrapped response events | Integration tests unwrap the published response with the sender key, verify its NIP-17 rumor/reply tags and bot authorship, and assert relay fan-out plus partial/all-failure semantics. |

## Verification gates

Run the focused test file after each Red and Green step, followed by the full suite. Before implementation is considered complete, all repository-required gates must pass:

```bash
npm test
npm run lint
npm run build
npm audit
```

`npm audit` must report zero vulnerabilities. Do not waive findings. Run `npm run test:coverage` as an additional review aid for protocol rejection branches, but not as a substitute for the required commands.

Automated tests must not use public relay availability. Construct valid encrypted fixtures locally with deterministic sender/recipient keys, and use typed relay/subscription fakes for delivery and acknowledgement behavior. Never print fixture private keys, decrypted content, or ciphertext in test diagnostics beyond fixed non-production test vectors.

## Implementation risks and mitigations

- **Sender impersonation:** Decryption alone does not authenticate the rumor author. Verify the seal signature and require seal/rumor pubkey equality before building `CommandContext`.
- **Recipient confusion:** Require both the outer wrapper and inner rumor to address the bot. Reject ambiguous/multiple outer recipient tags for this one-to-one DM slice.
- **Untrusted JSON and resource exhaustion:** Treat both decrypted layers as `unknown`, structurally narrow them, and reject oversized encrypted input before crypto/JSON work.
- **Duplicate command side effects:** Relays may deliver the same gift wrap multiple times. Deduplicate by verified outer ID with a bounded cache before handler execution.
- **Lost subscriptions after reconnect:** The pool's built-in reconnect is deliberately disabled by issue #2. Reattach the stored subscription when the manager's explicit reconnect succeeds.
- **Competing transport owners:** Subscription and publishing code must use the manager-owned relay/pool objects. A second `SimplePool` would violate lifecycle ownership and leak sockets on stop.
- **Partial relay outages:** Publish concurrently and require at least one acknowledgement; do not fail a delivered reply merely because another relay is unavailable.
- **Shutdown races:** Gate subscription callbacks, handler continuations, and publishes by lifecycle generation, close subscriptions before sockets, and settle tracked tasks without unhandled rejections.
- **Secret/plaintext leakage:** Do not log or include `nsec`, key bytes, raw decrypted events, command text, or reply text in protocol/publication errors.
- **Relay routing interoperability:** Configured-relay publication does not discover the recipient's NIP-17 `kind:10050` list. Document this slice boundary and add relay discovery before claiming full recipient-inbox routing compliance.
- **NIP draft evolution:** NIP-17 is marked draft. Keep protocol code isolated and pin tests to the locked `nostr-tools` behavior so future dependency/spec changes are reviewed explicitly.

## Definition of done

- Every issue #3 acceptance criterion has deterministic unit/integration evidence.
- Every production behavior was introduced through an observed Red–Green–Refactor cycle.
- Inbound identity and recipient validation covers the complete wrapper/seal/rumor chain.
- Duplicate delivery and reconnects cannot execute a command more than once per run.
- Replies are fresh NIP-17/NIP-59 gift wraps and are acknowledged by at least one configured relay or fail safely.
- `start()`/`stop()` remain idempotent, no second pool is introduced, and shutdown leaves no live subscriptions, sockets, timers, or unhandled tasks.
- No later parent-PRD business slice is pulled into this repository change.
- Public documentation states both the E2EE behavior and the configured-relay routing limitation.
- `npm test`, `npm run lint`, `npm run build`, and `npm audit` all pass, with zero audit vulnerabilities.
