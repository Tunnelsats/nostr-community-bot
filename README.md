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
console.log("Nostr Community Bot is running!");
```

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
