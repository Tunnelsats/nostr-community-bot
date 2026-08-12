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
│  - NIP-17 Encrypted DM Parser                          │
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
