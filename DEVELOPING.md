# Development & Architecture Guide

Welcome to **`nostr-community-bot`**. This document details the architectural concepts, testing framework, Test-Driven Development (TDD) workflow, and development best practices.

---

## 1. Architectural Concepts

`nostr-community-bot` is built to bridge generic Nostr relays, Armada Concord V2 Communities, and NIP-29 Relay Groups with custom application backends.

```
┌────────────────────────────────────────────────────────┐
│               Nostr Relays / Armada Client             │
└───────────────────────────┬────────────────────────────┘
                            │ (NIP-17 E2EE DMs / NIP-59)
                            ▼
┌────────────────────────────────────────────────────────┐
│                 NostrCommunityBot                      │
│  - Relay Connection Manager                            │
│    - Per-relay state & exponential reconnect            │
│    - Graceful socket/timer shutdown                     │
│  - NIP-17 Encrypted DM Parser                          │
│    - Strict gift wrap / seal / rumor validation        │
│    - Per-run cross-relay event deduplication            │
│  - Command Registry                                    │
└───────────────────────────┬────────────────────────────┘
                            │ (Typed CommandContext)
                            ▼
┌────────────────────────────────────────────────────────┐
│                Custom Application Handlers             │
│  (e.g., Tunnel-Bot LND Pings, Subscriptions, Amboss)   │
└────────────────────────────────────────────────────────┘
```

### Core Features

- **NIP-17 & NIP-59 Encrypted Direct Messages**: Client-side E2EE message processing.
- **Pluggable Command Registry**: Register slash commands (`/ping`, `/info`, `/tunnelsats`, `/link`) using `bot.registerCommand(name, handler)`.
- **Event Relay Bus**: Automatic reconnection, event deduplication, and payload verification.

### Relay lifecycle ownership

`NostrCommunityBot` owns one internal relay connection manager. Calling `start()` attempts every configured relay concurrently, keeps failures isolated per relay, and maintains live connections with bounded exponential reconnect delays. Calling `stop()` disables event dispatch and reconnection before closing subscriptions and the pool, cancels pending connection attempts and retry timers, settles tracked event work, and returns relay states to `disconnected`.

Use `getRelayStatuses()` for an immutable status snapshot. Event subscriptions and publishing reuse the manager-owned `SimplePool` and connected relay objects; they must not create a second pool or a competing reconnect loop. Persistent subscription definitions attach once to each connected relay and are reattached only for the relay that reconnects. Reply publication fans out concurrently and succeeds when at least one connected relay acknowledges the event.

Automated tests use typed pool/relay fakes and Vitest fake timers. Do not depend on public relay availability in CI.

### Encrypted direct-message validation

Inbound direct messages use the full NIP-59 trust chain before command parsing:

```text
verified kind 1059 gift wrap, p-tagged to bot
  -> NIP-44 decrypt with bot secret and one-time wrapper pubkey
verified kind 13 seal, signed by real sender, with empty tags
  -> NIP-44 decrypt with bot secret and seal pubkey
unsigned kind 14 rumor, p-tagged to bot, with a valid event hash
```

The seal pubkey must equal the rumor pubkey. That verified identity becomes `CommandContext.senderPubkey`, while `CommandContext.eventId` is the private rumor ID used by encrypted replies. Never derive sender identity from the random outer gift-wrap pubkey.

Decrypted JSON is untrusted input. Narrow it from `unknown`, bound encrypted payload sizes before NIP-44 work, validate every event/hash/signature/tag invariant, and collapse protocol failures to sanitized errors. Never log secret-key bytes, ciphertext, decrypted commands, reply plaintext, or raw inner events.

The same verified outer event ID may arrive from several relays, so the bot uses a bounded per-run deduplication cache before executing handlers. The cache survives reconnects and is cleared after a completed stop. Async subscription handlers are isolated so one malformed event or rejected command cannot prevent later events from being processed.

`ctx.reply()` uses a fresh NIP-17 wrapper for every call and includes an `e` reply tag for the triggering rumor. It currently publishes to the configured relay set. Recipient `kind:10050` DM relay discovery is outside this slice and is required before describing the routing layer as fully NIP-17 compliant.

---

## 2. Test-Driven Development (TDD) Workflow

We enforce a strict **Test-Driven Development (TDD)** cycle:

```
    ┌──────────────┐
    │  1. RED      │ ──▶ Write a failing test for desired feature
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │  2. GREEN    │ ──▶ Implement minimal code to pass test
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │  3. REFACTOR │ ──▶ Clean up code while keeping tests green
    └──────────────┘
```

### Running Tests

We use **Vitest** for fast unit and integration testing.

```bash
# Run tests once
npm test

# Run tests in watch mode during TDD cycles
npm run test:watch

# Generate coverage report
npm run test:coverage
```

---

## 3. Development Best Practices

- **Zero Vulnerabilities Policy**: Always verify `npm audit` is clean before committing code.
- **Type Safety**: Avoid using `any`. Define strong interfaces in `src/types.ts`.
- **Sanitized Logging**: Never log private keys (`nsec`) or unencrypted user identity secrets (`wgPublicKey`).
- **Async Handling**: Always catch promise rejections and handle WebSocket disconnects gracefully.
