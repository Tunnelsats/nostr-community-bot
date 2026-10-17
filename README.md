# Nostr Community Bot (`nostr-community-bot`)

> A modular, pluggable Nostr bot engine for E2EE Direct Messages (NIP-17 / NIP-59), Armada Concord V2 Communities, and NIP-29 Groups.

[![CI Status](https://github.com/Tunnelsats/nostr-community-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Tunnelsats/nostr-community-bot/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- 🔐 **End-to-End Encrypted DMs**: NIP-17 & NIP-59 Gift Wrap support for private interaction and proactive DM delivery via `kind:10050` inbox relay discovery.
- 💬 **Armada Concord V2 Communities**: Opt-in self-certifying `kind:3313` direct invite acceptance, durable community state (`ConcordCommunityStore`), `kind:3308` control stream authority folding, `kind:3306` guestbook join welcome hooks (`onMemberJoin`), `@Bot` channel mentions (`onChannelMention`), proactive channel messages (`publishConcordChannelMessage`), and automatic `kind:5` WireGuard key-leak redaction.
- 🔌 **Pluggable Command Registry**: Easily attach custom slash commands (`/ping`, `/info`, `/welcome`, `/faq`, `/donate`, `/servers`, `/tunnelsats`, `/link`) with configurable channel vs. DM scope (`allowInChannel`).
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

// Register a custom command (optionally overriding allowInChannel)
bot.registerCommand(
  "ping",
  async (ctx) => {
    const target = ctx.args[0] || "node";
    // For a NIP-17 DM, reply() creates a fresh encrypted gift wrap addressed
    // to the authenticated sender and links it to the incoming private rumor.
    // For a Concord channel command, reply() publishes a sealed kind:9 reply.
    await ctx.reply(`Pong! Pinging ${target} from Nostr Community Bot...`);
  },
  { allowInChannel: true },
);

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

`start()` connects to all configured relays concurrently and subscribes for NIP-59 `kind:1059` gift wraps addressed to the bot. Valid NIP-17 `kind:14` rumors are decrypted locally and dispatched through the command registry. The command context identifies the authenticated rumor author - not the gift wrap's random public key - and `ctx.reply()` encrypts a fresh NIP-17 response before publishing it.

If one relay is unavailable, the bot keeps healthy connections open and retries the failed relay with bounded exponential backoff. Encrypted subscriptions are restored after reconnect, and duplicate delivery of the same gift wrap across relays is processed once per running lifecycle. `getRelayStatuses()` returns a snapshot of each relay's current state, and `stop()` is safe to call repeatedly.

### Durable Replay Protection

Historical DM and Concord event intake is bounded to five minutes by default. For restart-safe command handling, configure a durable processed-event store:

```typescript
import type { ProcessedEventStore } from "nostr-community-bot";

const processedEvents: ProcessedEventStore = {
  isProcessed: async (eventId) => database.has(eventId),
  markProcessed: async (eventId) => database.insertIfAbsent(eventId),
};

const bot = new NostrCommunityBot({
  nsec: "nsec1...",
  relays: ["wss://relay.ditto.pub"],
  directMessageReplay: {
    offlineGraceSeconds: 300,
    store: processedEvents,
  },
});
```

`markProcessed` runs before command dispatch. For overlapping bot processes, it must atomically insert the authenticated inner-rumor ID and return `false` when that ID was already claimed. Store errors fail closed, so commands are not dispatched when durable deduplication is unavailable. The offline grace may be configured from 0 to 604800 seconds (seven days).

### Armada Concord V2 Communities

Enable `concord` in `NostrBotConfig` to accept `kind:3313` direct invites (including subsequent re-invites that add private channels or rotate channel/community epochs), persist joined communities across restarts via `ConcordCommunityStore`, welcome new members on `kind:3306` guestbook joins, respond to `@Bot` channel mentions, and publish proactive channel updates:

```typescript
import {
  NostrCommunityBot,
  type ConcordCommunityStore,
} from "nostr-community-bot";

const communityStore: ConcordCommunityStore = {
  loadCommunities: async () => database.loadConcordCommunities(),
  saveCommunity: async (community) => database.saveConcordCommunity(community),
};

const bot = new NostrCommunityBot({
  nsec: "nsec1...",
  relays: ["wss://relay.ditto.pub"],
  concord: {
    enabled: true,
    store: communityStore,
    defaultChannelId: "general",
    channelReadyTimeoutMs: 1500, // Wait window for async Control stream channel folding on startup
    allowedCommunityIds: [
      "7db995b3dff87ba5c4348007834cc0f98ef0abb6f761e0aac17bfea4b90593ca",
    ],
    allowedInviterPubkeys: ["npub1..."],
  },
});

bot.onMemberJoin(async (ctx) => {
  await ctx.replyChannel(`Welcome nostr:${ctx.memberNpub} to ${ctx.communityName}!`);
});

bot.onChannelMention(async (ctx) => {
  await ctx.reply(`Hi nostr:${ctx.senderNpub}! Run /help or /welcome for commands.`);
});

await bot.start();

// Publish a proactive message to a public or invited private Concord channel (by channel ID or name):
await bot.publishConcordChannelMessage("default", "general", "Scheduled status update");
await bot.publishConcordChannelMessage(
  "7db995b3dff87ba5c4348007834cc0f98ef0abb6f761e0aac17bfea4b90593ca",
  "0daff3a90287ce6bef9a4f372aaa7b5689178ad5ec47c1647df22169b42cb314",
  "Operational notification in private Notifications channel",
);
```

- **Invite Sender & Community Allow-List Enforcement**: `kind:3313` direct invites are accepted only for communities matching `allowedCommunityIds` (when configured) and only when the NIP-59 `kind:13` seal / rumor author (`rumor.pubkey`) is the verified community `owner`, an entry in `allowedInviterPubkeys`, or a folded community `admin` (`existing.control.roleFor(rumor.pubkey)`). Unprivileged community members and foreign communities cannot invite the bot or inject/rotate private channel keys.
- **Private Channel Isolation**: Invite-only private channels (`bundle.channels` with `source: "invite"` or `private: true` in the `kind:3308` Control stream, such as a dedicated `"Notifications"` channel) are isolated from public channel fallbacks (`resolveDefaultChannel` and `publishConcordChannelMessage("...", "general", ...)` never fall back to a private channel while `#general` is folding on startup).
- **Direct Re-Invite Merging & Epoch Rotation**: Receiving an updated `kind:3313` direct invite for an already-joined community merges newly invited private channels and relays, rotates channel keys/epochs and community `root_epoch`/`community_root` when incremented, disposes superseded subscriptions, and persists the updated bundle via `ConcordCommunityStore.saveCommunity`.
- **Role Resolution**: When Concord is enabled, both channel commands and NIP-17 DM commands receive `ctx.senderRole` (`"owner" | "admin" | "moderator" | "member"`) and `ctx.isModerator` resolved from the folded `kind:3308` control stream (for DMs, resolved against the community's target channel such as `defaultChannelId`).

### Proactive NIP-17 Direct Messages

`bot.sendDirectMessage(recipientPubkey, message)` queries `kind:10050` DM relay lists for both the bot and the recipient, validates that every relay URL resolves exclusively to public IPv4/IPv6 addresses over `wss:`, and publishes sender and recipient NIP-17 gift wraps. Keep the bot `nsec` in a secret store or `.env` file: never log it, pass it through a command context, or commit it to source control.

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
