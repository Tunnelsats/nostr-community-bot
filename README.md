# Nostr Community Bot (`nostr-community-bot`)

> A modular, pluggable Nostr bot engine for E2EE Direct Messages (NIP-17 / NIP-59), Armada Concord V2 Communities, and NIP-29 Groups.

[![CI Status](https://github.com/Tunnelsats/nostr-community-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Tunnelsats/nostr-community-bot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- 🔐 **End-to-End Encrypted DMs**: NIP-17 & NIP-59 Gift Wrap support for private interaction without server logging.
- 💬 **Armada & Nostr Community Support**: Connects seamlessly with Armada Concord V2 communities and NIP-29 group relays.
- 🔌 **Pluggable Command Registry**: Easily attach custom slash commands (`/ping`, `/info`, `/tunnelsats`, `/link`).
- ⚡ **Lightning & Node Integration**: Designed to bridge Nostr events with Lightning nodes (LND, CLN) and external APIs.
- 🧪 **TDD & High Quality**: Built with 100% Test-Driven Development via Vitest and strict TypeScript.

---

## Quick Start

### Installation

```bash
npm install nostr-community-bot
```

### Usage Example

```typescript
import { NostrCommunityBot } from "nostr-community-bot";

const bot = new NostrCommunityBot({
  nsec: "nsec1...", // Your bot secret key
  relays: ["wss://relay.ditto.pub", "wss://relay.damus.io"],
});

// Register a custom command
bot.registerCommand("ping", async (ctx) => {
  const target = ctx.args[0] || "node";
  await ctx.reply(`Pong! Pinging ${target} from Nostr Community Bot...`);
});

// Start listening
await bot.start();
console.log(bot.getRelayStatuses());
console.log("Nostr Community Bot is running!");

// Close sockets and cancel reconnect attempts during process shutdown.
const shutdown = async () => {
  try {
    await bot.stop();
  } catch (error) {
    console.error("Failed to stop Nostr Community Bot cleanly:", error);
    process.exitCode = 1;
  }
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
```

`start()` connects to all configured relays concurrently. If one relay is unavailable, the bot keeps healthy connections open and retries the failed relay with bounded exponential backoff. `getRelayStatuses()` returns a snapshot of each relay's current state, and `stop()` is safe to call repeatedly.

---

## Development & Testing

See [DEVELOPING.md](DEVELOPING.md) for architecture details, TDD setup, and test runner usage.

```bash
npm install
npm test
npm run build
```

---

## Security

Please refer to [SECURITY.md](SECURITY.md) for our Zero Vulnerabilities Policy and security vulnerability reporting instructions.

---

## License

[MIT License](LICENSE) © 2026 TunnelSats & Community
