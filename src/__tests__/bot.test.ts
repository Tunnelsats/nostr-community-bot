import { beforeEach, describe, it, expect, vi } from "vitest";
import { nip17, nip19, nip59 } from "nostr-tools";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
} from "nostr-tools/pure";
import { NostrCommunityBot } from "../bot.js";
import { unwrapDirectMessage } from "../nip17-dm.js";
import {
  CONCORD_CONTROL_KIND,
  CONCORD_JOIN_KIND,
  computeConcordCommunityId,
  computeConcordGrantLocator,
  createConcordStreamEvent,
  decodeConcordStreamEvent,
  deriveConcordGroupKey,
  type ConcordInviteBundle,
} from "../concord.js";

const relayPoolMocks = vi.hoisted(() => ({
  ensureRelay: vi.fn(),
  close: vi.fn(),
  subscribe: vi.fn(),
  publish: vi.fn(),
  useWebSocketImplementation: vi.fn(),
}));

vi.mock("nostr-tools/pool", () => ({
  SimplePool: class {
    public ensureRelay = relayPoolMocks.ensureRelay;
    public close = relayPoolMocks.close;
  },
  useWebSocketImplementation: relayPoolMocks.useWebSocketImplementation,
}));

const TEST_RELAYS = ["wss://relay.ditto.pub", "wss://relay.damus.io"];
const BOT_SECRET = generateSecretKey();
const TEST_SECRET_HEX = Buffer.from(BOT_SECRET).toString("hex");
const SENDER_SECRET = generateSecretKey();
const SENDER_PUBKEY = getPublicKey(SENDER_SECRET);

function createDmRelayList(secretKey: Uint8Array, relays: string[]): NostrEvent {
  return finalizeEvent(
    {
      kind: 10050,
      created_at: 1_700_000_000,
      content: "",
      tags: relays.map((relay) => ["relay", relay]),
    },
    secretKey,
  );
}

function createMockRelay(): {
  onclose: (() => void) | null;
  subscribe: typeof relayPoolMocks.subscribe;
  publish: typeof relayPoolMocks.publish;
} {
  return {
    onclose: null,
    subscribe: relayPoolMocks.subscribe,
    publish: relayPoolMocks.publish,
  };
}

function createInboundMessage(message: string, botPubkey: string): NostrEvent {
  return nip17.wrapEvent(SENDER_SECRET, { publicKey: botPubkey }, message);
}

function createInboundMessageAt(message: string, botPubkey: string, createdAt: number): NostrEvent {
  return nip59.wrapManyEvents(
    {
      kind: 14,
      created_at: createdAt,
      tags: [["p", botPubkey]],
      content: message,
    },
    SENDER_SECRET,
    [botPubkey],
  )[1];
}

function createInboundConcordInvite(botPubkey: string): {
  wrap: NostrEvent;
  bundle: ConcordInviteBundle;
} {
  const ownerSalt = "11".repeat(32);
  const communityRoot = "22".repeat(32);
  const channelId = "33".repeat(32);
  const channelKey = "44".repeat(32);
  const bundle: ConcordInviteBundle = {
    community_id: computeConcordCommunityId(SENDER_PUBKEY, ownerSalt),
    owner: SENDER_PUBKEY,
    owner_salt: ownerSalt,
    community_root: communityRoot,
    root_epoch: 1,
    control_pk: "55".repeat(32),
    channels: [{ id: channelId, key: channelKey, epoch: 1, name: "general" }],
    relays: [TEST_RELAYS[0]],
    name: "Test community",
  };
  const copies = nip59.wrapManyEvents(
    {
      kind: 3313,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [],
      content: JSON.stringify(bundle),
    },
    SENDER_SECRET,
    [botPubkey],
  );
  return { wrap: copies[1], bundle };
}

function emitSubscriptionEvent(callIndex: number, event: NostrEvent): void {
  const params = relayPoolMocks.subscribe.mock.calls[callIndex]?.[1] as
    | { onevent?: (received: NostrEvent) => void }
    | undefined;
  params?.onevent?.(event);
}

beforeEach(() => {
  relayPoolMocks.ensureRelay.mockReset();
  relayPoolMocks.close.mockReset();
  relayPoolMocks.subscribe.mockReset();
  relayPoolMocks.publish.mockReset();
  relayPoolMocks.subscribe.mockImplementation(() => ({ close: vi.fn() }));
  relayPoolMocks.publish.mockResolvedValue("saved");
});

describe("NostrCommunityBot", () => {
  it("sends proactive NIP-17 recipient and sender copies through declared DM relays", async () => {
    const botRelayList = createDmRelayList(BOT_SECRET, [TEST_RELAYS[0]]);
    const recipientRelayList = createDmRelayList(SENDER_SECRET, [TEST_RELAYS[1]]);
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(10050)) {
        const author = filters[0].authors?.[0];
        queueMicrotask(() => {
          if (author === botRelayList.pubkey) params.onevent?.(botRelayList);
          if (author === recipientRelayList.pubkey) params.onevent?.(recipientRelayList);
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      resolveHostname: async () => ["93.184.216.34"],
    });
    await bot.start();

    await bot.sendDirectMessage(SENDER_PUBKEY, "Subscription expires soon");

    expect(relayPoolMocks.publish).toHaveBeenCalledTimes(2);
    const senderCopy = relayPoolMocks.publish.mock.calls[0][0] as NostrEvent;
    const recipientCopy = relayPoolMocks.publish.mock.calls[1][0] as NostrEvent;
    const senderRumor = nip59.unwrapEvent(senderCopy, BOT_SECRET);
    const recipientRumor = unwrapDirectMessage(recipientCopy, SENDER_SECRET, SENDER_PUBKEY);
    expect(senderRumor.id).toBe(recipientRumor.id);
    expect(recipientRumor.content).toBe("Subscription expires soon");
  });

  it("does not publish a proactive DM without both kind 10050 relay lists", async () => {
    const botRelayList = createDmRelayList(BOT_SECRET, [TEST_RELAYS[0]]);
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(10050)) {
        queueMicrotask(() => {
          if (filters[0].authors?.[0] === botRelayList.pubkey) {
            params.onevent?.(botRelayList);
          }
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      resolveHostname: async () => ["93.184.216.34"],
    });
    await bot.start();

    await expect(
      bot.sendDirectMessage(SENDER_PUBKEY, "Subscription expires soon"),
    ).rejects.toThrow("Nostr direct message recipient is not ready");
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });

  it("rejects private recipient relay destinations before publishing", async () => {
    const botRelayList = createDmRelayList(BOT_SECRET, [TEST_RELAYS[0]]);
    const recipientRelayList = createDmRelayList(SENDER_SECRET, ["wss://127.0.0.1"]);
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(10050)) {
        queueMicrotask(() => {
          if (filters[0].authors?.[0] === botRelayList.pubkey) params.onevent?.(botRelayList);
          if (filters[0].authors?.[0] === recipientRelayList.pubkey) {
            params.onevent?.(recipientRelayList);
          }
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      resolveHostname: async () => ["93.184.216.34"],
    });
    await bot.start();

    await expect(bot.sendDirectMessage(SENDER_PUBKEY, "secret alert")).rejects.toThrow(
      "Nostr direct message recipient is not ready",
    );
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });

  it("does not publish the customer copy when the sender copy fails", async () => {
    const botRelayList = createDmRelayList(BOT_SECRET, [TEST_RELAYS[0]]);
    const recipientRelayList = createDmRelayList(SENDER_SECRET, [TEST_RELAYS[1]]);
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.publish.mockRejectedValue(new Error("relay leaked failure"));
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(10050)) {
        queueMicrotask(() => {
          if (filters[0].authors?.[0] === botRelayList.pubkey) params.onevent?.(botRelayList);
          if (filters[0].authors?.[0] === recipientRelayList.pubkey) {
            params.onevent?.(recipientRelayList);
          }
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      resolveHostname: async () => ["93.184.216.34"],
    });
    await bot.start();

    await expect(bot.sendDirectMessage(SENDER_PUBKEY, "secret alert")).rejects.toThrow(
      "Relay publication failed",
    );
    expect(relayPoolMocks.publish).toHaveBeenCalledTimes(1);
  });

  it("revalidates cached relay hostnames before reusing them", async () => {
    const botRelayList = createDmRelayList(BOT_SECRET, [TEST_RELAYS[0]]);
    const recipientRelayList = createDmRelayList(SENDER_SECRET, [TEST_RELAYS[1]]);
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(10050)) {
        queueMicrotask(() => {
          if (filters[0].authors?.[0] === botRelayList.pubkey) params.onevent?.(botRelayList);
          if (filters[0].authors?.[0] === recipientRelayList.pubkey) {
            params.onevent?.(recipientRelayList);
          }
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });
    const resolveHostname = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValue(["127.0.0.1"]);
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      resolveHostname,
    });
    await bot.start();
    await bot.sendDirectMessage(SENDER_PUBKEY, "first alert");
    relayPoolMocks.publish.mockClear();

    await expect(bot.sendDirectMessage(SENDER_PUBKEY, "second alert")).rejects.toThrow(
      "Nostr direct message recipient is not ready",
    );
    expect(resolveHostname).toHaveBeenCalledTimes(4);
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });

  it("rejects relay lists that exceed the configured bound", async () => {
    const excessiveRelays = [
      "wss://one.example",
      "wss://two.example",
      "wss://three.example",
      "wss://four.example",
    ];
    const botRelayList = createDmRelayList(BOT_SECRET, excessiveRelays);
    const recipientRelayList = createDmRelayList(SENDER_SECRET, [TEST_RELAYS[1]]);
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(10050)) {
        queueMicrotask(() => {
          if (filters[0].authors?.[0] === botRelayList.pubkey) params.onevent?.(botRelayList);
          if (filters[0].authors?.[0] === recipientRelayList.pubkey) {
            params.onevent?.(recipientRelayList);
          }
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      resolveHostname: async () => ["93.184.216.34"],
    });
    await bot.start();

    await expect(bot.sendDirectMessage(SENDER_PUBKEY, "secret alert")).rejects.toThrow(
      "Nostr direct message recipient is not ready",
    );
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });

  it("rejects oversized kind 10050 metadata before signature verification", async () => {
    const oversizedBotRelayList = createDmRelayList(BOT_SECRET, [TEST_RELAYS[0]]);
    oversizedBotRelayList.tags = Array.from({ length: 65 }, () => [
      "relay",
      TEST_RELAYS[0],
    ]);
    const recipientRelayList = createDmRelayList(SENDER_SECRET, [TEST_RELAYS[1]]);
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(10050)) {
        queueMicrotask(() => {
          if (filters[0].authors?.[0] === oversizedBotRelayList.pubkey) {
            params.onevent?.(oversizedBotRelayList);
          }
          if (filters[0].authors?.[0] === recipientRelayList.pubkey) {
            params.onevent?.(recipientRelayList);
          }
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      resolveHostname: async () => ["93.184.216.34"],
    });
    await bot.start();

    await expect(bot.sendDirectMessage(SENDER_PUBKEY, "secret alert")).rejects.toThrow(
      "Nostr direct message recipient is not ready",
    );
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });

  it("rejects structurally malformed relay metadata without exposing parser errors", async () => {
    const malformedBotRelayList = createDmRelayList(BOT_SECRET, [TEST_RELAYS[0]]);
    malformedBotRelayList.tags = null as unknown as string[][];
    const recipientRelayList = createDmRelayList(SENDER_SECRET, [TEST_RELAYS[1]]);
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(10050)) {
        queueMicrotask(() => {
          if (filters[0].authors?.[0] === malformedBotRelayList.pubkey) {
            params.onevent?.(malformedBotRelayList);
          }
          if (filters[0].authors?.[0] === recipientRelayList.pubkey) {
            params.onevent?.(recipientRelayList);
          }
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      resolveHostname: async () => ["93.184.216.34"],
    });
    await bot.start();

    await expect(bot.sendDirectMessage(SENDER_PUBKEY, "secret alert")).rejects.toThrow(
      "Nostr direct message recipient is not ready",
    );
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });

  it("initializes successfully with valid config", () => {
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
    });

    expect(bot.getPublicKeyHex()).toBe(getPublicKey(BOT_SECRET));
    expect(bot.getPublicKeyNpub()).toBe(nip19.npubEncode(getPublicKey(BOT_SECRET)));
    expect(bot.getRelays()).toEqual(TEST_RELAYS);
  });

  it.each([-1, 604_801, 1.5, Number.NaN])(
    "rejects an invalid direct-message offline grace of %s seconds",
    (offlineGraceSeconds) => {
      expect(
        () =>
          new NostrCommunityBot({
            nsec: TEST_SECRET_HEX,
            relays: TEST_RELAYS,
            directMessageReplay: { offlineGraceSeconds },
          }),
      ).toThrow("direct-message offline grace");
    },
  );

  it("registers and executes commands with configurable channel permissions", async () => {
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
    });

    const handler = vi.fn(async (ctx) => {
      await ctx.reply(`Pong! Arg: ${ctx.args[0]}`);
    });

    bot.registerCommand("ping", handler);
    bot.registerCommand("welcome", handler);
    bot.registerCommand("link", handler);
    bot.registerCommand("custom-pub", handler, { allowInChannel: true });
    bot.registerCommand("info", handler, { allowInChannel: false });

    expect(bot.getRegisteredCommands()).toContain("ping");
    expect(bot.isCommandAllowedInChannel("ping")).toBe(true);
    expect(bot.isCommandAllowedInChannel("welcome")).toBe(true);
    expect(bot.isCommandAllowedInChannel("setwelcome")).toBe(true);
    expect(bot.isCommandAllowedInChannel("link")).toBe(false);
    expect(bot.isCommandAllowedInChannel("custom-pub")).toBe(true);
    expect(bot.isCommandAllowedInChannel("info")).toBe(false);

    const replyFn = vi.fn();
    const handled = await bot.processMessage(
      "/ping my-node",
      "sender-pubkey-123",
      "event-id-456",
      replyFn,
    );

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(replyFn).toHaveBeenCalledWith("Pong! Arg: my-node");
  });

  it("ignores non-command or unregistered messages", async () => {
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
    });

    const handledMsg = await bot.processMessage("hello world", "sender-123", "evt-123");
    expect(handledMsg).toBe(false);

    const handledUnknownCmd = await bot.processMessage("/unknown", "sender-123", "evt-123");
    expect(handledUnknownCmd).toBe(false);
  });

  it("starts configured relays and exposes their connection statuses", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
    });

    await bot.start();

    expect(relayPoolMocks.ensureRelay).toHaveBeenCalledTimes(TEST_RELAYS.length);
    expect(bot.getRelayStatuses()).toEqual(
      TEST_RELAYS.map((url) => ({ url, state: "connected", reconnectAttempts: 0 })),
    );
  });

  it("deduplicates repeated relay URLs", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: [TEST_RELAYS[0], TEST_RELAYS[0]],
    });

    await bot.start();

    expect(bot.getRelays()).toEqual([TEST_RELAYS[0]]);
    expect(bot.getRelayStatuses()).toEqual([
      { url: TEST_RELAYS[0], state: "connected", reconnectAttempts: 0 },
    ]);
    expect(relayPoolMocks.ensureRelay).toHaveBeenCalledTimes(1);
  });

  it("stops configured relays and returns them to disconnected status", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
    });
    await bot.start();

    await bot.stop();
    await bot.stop();

    expect(relayPoolMocks.close).toHaveBeenCalledTimes(1);
    expect(relayPoolMocks.close).toHaveBeenCalledWith(TEST_RELAYS);
    expect(bot.getRelayStatuses()).toEqual(
      TEST_RELAYS.map((url) => ({ url, state: "disconnected", reconnectAttempts: 0 })),
    );
  });

  it("subscribes for gift wraps addressed to the bot", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const now = 1_800_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now * 1_000);
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    nowSpy.mockRestore();

    await bot.start();

    expect(relayPoolMocks.subscribe).toHaveBeenCalledTimes(TEST_RELAYS.length);
    for (const [filters] of relayPoolMocks.subscribe.mock.calls) {
      expect(filters).toEqual([
        {
          kinds: [1059],
          "#p": [bot.getPublicKeyHex()],
          since: now - 300 - 2 * 24 * 60 * 60,
        },
      ]);
    }
  });

  it("discards authenticated direct messages older than the configured offline window", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1_000);
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      directMessageReplay: { offlineGraceSeconds: 60 },
    });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();

    emitSubscriptionEvent(
      0,
      createInboundMessageAt("/ping stale", bot.getPublicKeyHex(), now - 61),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    clock.mockRestore();

    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps the authenticated rumor cutoff bounded during a long-running process", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const startup = 1_800_000_000;
    const startupClock = vi.spyOn(Date, "now").mockReturnValue(startup * 1_000);
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      directMessageReplay: { offlineGraceSeconds: 60 },
    });
    startupClock.mockRestore();
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();
    const laterClock = vi.spyOn(Date, "now").mockReturnValue((startup + 120) * 1_000);

    emitSubscriptionEvent(
      0,
      createInboundMessageAt("/ping expired", bot.getPublicKeyHex(), startup + 1),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    laterClock.mockRestore();

    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects authenticated rumors too far in the future", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1_000);
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();

    emitSubscriptionEvent(
      0,
      createInboundMessageAt("/ping future", bot.getPublicKeyHex(), now + 301),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    clock.mockRestore();

    expect(handler).not.toHaveBeenCalled();
  });

  it("uses a persistent store to suppress a rewrapped rumor across bot instances", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const processed = new Set<string>();
    const store = {
      isProcessed: vi.fn((eventId: string) => processed.has(eventId)),
      markProcessed: vi.fn((eventId: string) => {
        processed.add(eventId);
      }),
    };
    const first = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      directMessageReplay: { store },
    });
    const wrap = createInboundMessage("/ping once", first.getPublicKeyHex());
    const rumor = unwrapDirectMessage(wrap, BOT_SECRET, first.getPublicKeyHex());
    const firstHandler = vi.fn(() => {
      expect(processed.has(rumor.id)).toBe(true);
    });
    first.registerCommand("ping", firstHandler);
    await first.start();

    emitSubscriptionEvent(0, wrap);
    await vi.waitFor(() => expect(firstHandler).toHaveBeenCalledTimes(1));
    expect(store.markProcessed).toHaveBeenCalledWith(rumor.id);
    await first.stop();

    const second = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      directMessageReplay: { store },
    });
    const secondHandler = vi.fn();
    second.registerCommand("ping", secondHandler);
    await second.start();
    const rewrapped = nip59.wrapManyEvents(
      {
        kind: 14,
        created_at: rumor.created_at,
        tags: rumor.tags,
        content: rumor.content,
      },
      SENDER_SECRET,
      [second.getPublicKeyHex()],
    )[1];
    emitSubscriptionEvent(TEST_RELAYS.length, rewrapped);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(rewrapped.id).not.toBe(wrap.id);
    expect(store.isProcessed).toHaveBeenCalledWith(rumor.id);
    expect(secondHandler).not.toHaveBeenCalled();
  });

  it("fails closed when the persistent processed-event store is unavailable", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      directMessageReplay: {
        store: {
          isProcessed: vi.fn(() => Promise.reject(new Error("database unavailable"))),
          markProcessed: vi.fn(),
        },
      },
    });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();

    emitSubscriptionEvent(0, createInboundMessage("/ping blocked", bot.getPublicKeyHex()));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handler).not.toHaveBeenCalled();
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });

  it("dispatches only when the persistent store atomically claims the rumor", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const store = {
      isProcessed: vi.fn(() => false),
      markProcessed: vi.fn(() => false),
    };
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      directMessageReplay: { store },
    });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();

    emitSubscriptionEvent(0, createInboundMessage("/ping raced", bot.getPublicKeyHex()));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.markProcessed).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches a validated encrypted command with authenticated context identity", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();
    const wrap = createInboundMessage("/ping node-id", bot.getPublicKeyHex());
    const expectedRumor = unwrapDirectMessage(wrap, BOT_SECRET, bot.getPublicKeyHex());

    emitSubscriptionEvent(0, wrap);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "ping",
        args: ["node-id"],
        senderPubkey: SENDER_PUBKEY,
        eventId: expectedRumor.id,
        transport: "dm",
        reply: expect.any(Function),
      }),
    );
  });

  it("ignores invalid, non-command, and unregistered encrypted messages", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();
    const invalid = createInboundMessage("/ping hidden", bot.getPublicKeyHex());
    invalid.content = "invalid-ciphertext";

    emitSubscriptionEvent(0, invalid);
    emitSubscriptionEvent(0, createInboundMessage("hello", bot.getPublicKeyHex()));
    emitSubscriptionEvent(0, createInboundMessage("/unknown", bot.getPublicKeyHex()));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handler).not.toHaveBeenCalled();
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });

  it("deduplicates the same gift wrap delivered by multiple relays", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();
    const wrap = createInboundMessage("/ping once", bot.getPublicKeyHex());

    emitSubscriptionEvent(0, wrap);
    emitSubscriptionEvent(1, wrap);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it("does not let an invalid envelope poison deduplication for a valid event", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();
    const valid = createInboundMessage("/ping valid", bot.getPublicKeyHex());
    const invalid = { ...valid, content: "invalid-ciphertext" };

    emitSubscriptionEvent(0, invalid);
    await Promise.resolve();
    emitSubscriptionEvent(1, valid);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  it("isolates handler failures and continues processing later events", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("handler failed"))
      .mockResolvedValue(undefined);
    bot.registerCommand("ping", handler);
    await bot.start();

    emitSubscriptionEvent(0, createInboundMessage("/ping first", bot.getPublicKeyHex()));
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    emitSubscriptionEvent(0, createInboundMessage("/ping second", bot.getPublicKeyHex()));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  });

  it("does not dispatch an event delivered after stop", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi.fn();
    bot.registerCommand("ping", handler);
    await bot.start();
    const wrap = createInboundMessage("/ping stopped", bot.getPublicKeyHex());
    const callback = relayPoolMocks.subscribe.mock.calls[0][1].onevent as (
      received: NostrEvent,
    ) => void;
    await bot.stop();

    callback(wrap);
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
  });

  it("encrypts and publishes replies that reference the inbound rumor", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    bot.registerCommand("ping", async (ctx) => ctx.reply("Pong"));
    await bot.start();
    const inbound = createInboundMessage("/ping", bot.getPublicKeyHex());
    const inboundRumor = unwrapDirectMessage(inbound, BOT_SECRET, bot.getPublicKeyHex());

    emitSubscriptionEvent(0, inbound);

    await vi.waitFor(() => expect(relayPoolMocks.publish).toHaveBeenCalledTimes(2));
    const published = relayPoolMocks.publish.mock.calls[0][0] as NostrEvent;
    expect(relayPoolMocks.publish.mock.calls[1][0]).toBe(published);
    expect(published.kind).toBe(1059);
    expect(published.pubkey).not.toBe(bot.getPublicKeyHex());
    expect(published.content).not.toContain("Pong");
    const response = unwrapDirectMessage(published, SENDER_SECRET, SENDER_PUBKEY);
    expect(response.pubkey).toBe(bot.getPublicKeyHex());
    expect(response.content).toBe("Pong");
    expect(response.tags).toContainEqual(["e", inboundRumor.id, "", "reply"]);
  });

  it("resolves replies after one acknowledgement and sanitizes total failure", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.publish
      .mockRejectedValueOnce(new Error("first relay secret failure"))
      .mockResolvedValueOnce("saved")
      .mockRejectedValue(new Error("all relays secret failure"));
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const outcomes: Array<string | Error> = [];
    bot.registerCommand("ping", async (ctx) => {
      try {
        await ctx.reply(ctx.args[0]);
        outcomes.push("sent");
      } catch (error) {
        outcomes.push(error as Error);
      }
    });
    await bot.start();

    emitSubscriptionEvent(0, createInboundMessage("/ping first", bot.getPublicKeyHex()));
    await vi.waitFor(() => expect(outcomes).toEqual(["sent"]));
    emitSubscriptionEvent(0, createInboundMessage("/ping second", bot.getPublicKeyHex()));
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));

    expect(outcomes[1]).toBeInstanceOf(Error);
    expect((outcomes[1] as Error).message).toBe("Relay publication failed");
    expect((outcomes[1] as Error).message).not.toContain("second");
    expect((outcomes[1] as Error).message).not.toContain("secret failure");
  });

  it("creates a fresh encrypted event for every reply call", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    bot.registerCommand("ping", async (ctx) => {
      await ctx.reply("first");
      await ctx.reply("second");
    });
    await bot.start();

    emitSubscriptionEvent(0, createInboundMessage("/ping", bot.getPublicKeyHex()));
    await vi.waitFor(() => expect(relayPoolMocks.publish).toHaveBeenCalledTimes(4));

    const first = relayPoolMocks.publish.mock.calls[0][0] as NostrEvent;
    const second = relayPoolMocks.publish.mock.calls[2][0] as NostrEvent;
    expect(first.id).not.toBe(second.id);
    expect(first.pubkey).not.toBe(second.pubkey);
  });

  it("keeps Concord invites inert unless explicitly enabled", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    await bot.start();

    emitSubscriptionEvent(0, createInboundConcordInvite(bot.getPublicKeyHex()).wrap);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
    expect(relayPoolMocks.subscribe).toHaveBeenCalledTimes(TEST_RELAYS.length);
  });

  it("accepts Concord direct invites and dispatches public channel commands", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      concord: { enabled: true },
    });
    const handler = vi.fn(async (context) => context.reply("Pong in channel"));
    bot.registerCommand("ping", handler);
    await bot.start();
    const { wrap, bundle } = createInboundConcordInvite(bot.getPublicKeyHex());

    emitSubscriptionEvent(0, wrap);
    await vi.waitFor(() => expect(relayPoolMocks.publish).toHaveBeenCalledTimes(1));

    const channel = bundle.channels[0];
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(channel.key, "hex"),
      Buffer.from(channel.id, "hex"),
      channel.epoch,
    );
    const subscriptionCall = relayPoolMocks.subscribe.mock.calls.find(
      ([filters]) => filters[0]?.authors?.[0] === group.publicKey,
    );
    expect(subscriptionCall).toBeDefined();
    const channelEvent = createConcordStreamEvent(SENDER_SECRET, group, {
      kind: 9,
      content: "/ping node",
      tags: [["channel", channel.id], ["epoch", String(channel.epoch)]],
      created_at: Math.floor(Date.now() / 1_000),
    });
    subscriptionCall?.[1].onevent?.(channelEvent);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "ping",
        args: ["node"],
        transport: "concord-channel",
        communityId: bundle.community_id,
        channelId: channel.id,
        channelName: "general",
        isModerator: true,
        senderRole: "owner",
      }),
    );
    await vi.waitFor(() => expect(relayPoolMocks.publish).toHaveBeenCalledTimes(2));
    const response = relayPoolMocks.publish.mock.calls[1][0] as NostrEvent;
    expect(
      decodeConcordStreamEvent(response, group, {
        channelId: channel.id,
        epoch: channel.epoch,
        allowedKinds: [9],
      })?.rumor.content,
    ).toBe("Pong in channel");
  });

  it("wires onMemberJoin, onChannelMention, and publishConcordChannelMessage through NostrCommunityBot", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      concord: { enabled: true },
    });
    const joinHandler = vi.fn(async (ctx) => {
      await ctx.replyChannel(`Welcome nostr:${ctx.memberNpub}`);
    });
    const mentionHandler = vi.fn(async (ctx) => {
      await ctx.reply(`Help for nostr:${ctx.senderNpub}`);
    });
    bot.onMemberJoin(joinHandler).onChannelMention(mentionHandler);
    await bot.start();

    const { wrap, bundle } = createInboundConcordInvite(bot.getPublicKeyHex());
    emitSubscriptionEvent(0, wrap);
    await vi.waitFor(() => expect(relayPoolMocks.publish).toHaveBeenCalledTimes(1));

    const guestbook = deriveConcordGroupKey(
      "concord/guestbook",
      Buffer.from(bundle.community_root, "hex"),
      Buffer.from(bundle.community_id, "hex"),
      bundle.root_epoch,
    );
    const guestbookSub = relayPoolMocks.subscribe.mock.calls.find(
      ([filters]) => filters[0]?.authors?.[0] === guestbook.publicKey,
    );
    const joinEvent = createConcordStreamEvent(SENDER_SECRET, guestbook, {
      kind: CONCORD_JOIN_KIND,
      content: "join",
      tags: [["ms", "10"]],
      created_at: Math.floor(Date.now() / 1_000),
    });
    guestbookSub?.[1].onevent?.(joinEvent);
    await vi.waitFor(() => expect(joinHandler).toHaveBeenCalledTimes(1));

    const channel = bundle.channels[0];
    const channelGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(channel.key, "hex"),
      Buffer.from(channel.id, "hex"),
      channel.epoch,
    );
    const channelSub = relayPoolMocks.subscribe.mock.calls.find(
      ([filters]) => filters[0]?.authors?.[0] === channelGroup.publicKey,
    );
    const mentionEvent = createConcordStreamEvent(SENDER_SECRET, channelGroup, {
      kind: 9,
      content: "Hello @TunnelSats",
      tags: [["channel", channel.id], ["epoch", String(channel.epoch)]],
      created_at: Math.floor(Date.now() / 1_000),
    });
    channelSub?.[1].onevent?.(mentionEvent);
    await vi.waitFor(() => expect(mentionHandler).toHaveBeenCalledTimes(1));

    await bot.publishConcordChannelMessage("default", "general", "Proactive announcement");
    expect(relayPoolMocks.publish).toHaveBeenCalledTimes(4);
  });

  it("stops relay connections when restoreCommunities throws during start", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      concord: {
        enabled: true,
        store: {
          loadCommunities: async () => {
            throw new Error("store failure");
          },
          saveCommunity: async () => undefined,
        },
      },
    });

    await expect(bot.start()).rejects.toThrow("store failure");
    expect(relayPoolMocks.close).toHaveBeenCalledWith(TEST_RELAYS);
    expect(bot.getRelayStatuses()).toEqual(
      TEST_RELAYS.map((url) => ({ url, state: "disconnected", reconnectAttempts: 0 })),
    );
  });

  it("allows retrying the same Concord invite gift-wrap event when Join publication fails transiently", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.publish
      .mockRejectedValueOnce(new Error("transient relay error"))
      .mockResolvedValue("saved");
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      concord: { enabled: true },
    });
    await bot.start();
    const { wrap } = createInboundConcordInvite(bot.getPublicKeyHex());

    emitSubscriptionEvent(0, wrap);
    await vi.waitFor(() => expect(relayPoolMocks.publish).toHaveBeenCalledTimes(1));

    emitSubscriptionEvent(1, wrap);
    await vi.waitFor(() => expect(relayPoolMocks.publish).toHaveBeenCalledTimes(2));
  });

  it("resolves senderRole and isModerator on NIP-17 DM commands from the community default channel", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const controlSignerSecret = generateSecretKey();
    const controlPk = getPublicKey(controlSignerSecret);
    const modSecret = generateSecretKey();
    const modPubkey = getPublicKey(modSecret);
    const memberSecret = generateSecretKey();
    const memberPubkey = getPublicKey(memberSecret);

    const ownerSalt = "11".repeat(32);
    const communityRoot = "22".repeat(32);
    const generalChannelId = "33".repeat(32);
    const channelKey = "44".repeat(32);
    const bundle: ConcordInviteBundle = {
      community_id: computeConcordCommunityId(SENDER_PUBKEY, ownerSalt),
      owner: SENDER_PUBKEY,
      owner_salt: ownerSalt,
      community_root: communityRoot,
      root_epoch: 1,
      control_pk: controlPk,
      channels: [{ id: generalChannelId, key: channelKey, epoch: 1, name: "general" }],
      relays: [TEST_RELAYS[0]],
      name: "Test community",
    };

    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      concord: {
        enabled: true,
        defaultChannelId: "general",
      },
    });
    const handler = vi.fn();
    bot.registerCommand("setwelcome", handler);
    await bot.start();

    const inviteWrap = nip59.wrapManyEvents(
      {
        kind: 3313,
        created_at: Math.floor(Date.now() / 1_000),
        tags: [],
        content: JSON.stringify(bundle),
      },
      SENDER_SECRET,
      [bot.getPublicKeyHex()],
    )[1];
    emitSubscriptionEvent(0, inviteWrap);
    await vi.waitFor(() => expect(relayPoolMocks.publish).toHaveBeenCalledTimes(1));

    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(communityRoot, "hex"),
      Buffer.from(bundle.community_id, "hex"),
      1,
    );
    const controlGroup = {
      ...controlRead,
      secretKey: controlSignerSecret,
      publicKey: controlPk,
    };
    const controlSub = relayPoolMocks.subscribe.mock.calls.find(
      ([filters]) => filters[0]?.authors?.[0] === controlPk,
    );
    expect(controlSub).toBeDefined();

    const modRoleId = "91".repeat(32);
    controlSub?.[1].onevent?.(
      createConcordStreamEvent(
        SENDER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({
            role_id: modRoleId,
            name: "Moderator",
            position: 2,
            permissions: "0",
            scope: { kind: "channel", channel_id: generalChannelId },
          }),
          tags: [["vsk", "1"], ["eid", modRoleId], ["ev", "1"]],
          created_at: Math.floor(Date.now() / 1_000),
        },
        { sealKind: 20014 },
      ),
    );
    controlSub?.[1].onevent?.(
      createConcordStreamEvent(
        SENDER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({ member: modPubkey, role_ids: [modRoleId] }),
          tags: [
            ["vsk", "3"],
            ["eid", computeConcordGrantLocator(bundle.community_id, modPubkey)],
            ["ev", "1"],
          ],
          created_at: Math.floor(Date.now() / 1_000),
        },
        { sealKind: 20014 },
      ),
    );

    await vi.waitFor(() =>
      expect(bot.getConcordMemberRole(modPubkey)).toBe("moderator"),
    );
    expect(bot.getConcordMemberRole(SENDER_PUBKEY)).toBe("owner");
    expect(bot.getConcordMemberRole(memberPubkey)).toBe("member");

    const ownerDm = nip17.wrapEvent(
      SENDER_SECRET,
      { publicKey: bot.getPublicKeyHex() },
      "/setwelcome Owner welcome!",
    );
    emitSubscriptionEvent(0, ownerDm);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "setwelcome",
        senderPubkey: SENDER_PUBKEY,
        transport: "dm",
        senderRole: "owner",
        isModerator: true,
      }),
    );

    const modDm = nip17.wrapEvent(
      modSecret,
      { publicKey: bot.getPublicKeyHex() },
      "/setwelcome Mod welcome!",
    );
    emitSubscriptionEvent(0, modDm);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "setwelcome",
        senderPubkey: modPubkey,
        transport: "dm",
        senderRole: "moderator",
        isModerator: true,
      }),
    );

    const memberDm = nip17.wrapEvent(
      memberSecret,
      { publicKey: bot.getPublicKeyHex() },
      "/setwelcome Member attempt",
    );
    emitSubscriptionEvent(0, memberDm);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "setwelcome",
        senderPubkey: memberPubkey,
        transport: "dm",
        senderRole: "member",
        isModerator: false,
      }),
    );
  });

  it("preserves rawText with multiline newlines in CommandContext", async () => {
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi.fn();
    bot.registerCommand("setwelcome", handler);

    const multilineText = "/setwelcome channel Line 1\n\nLine 2\n- Bullet A\n- Bullet B";
    await bot.processMessage(multilineText, SENDER_PUBKEY, "event-multiline");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "setwelcome",
        rawText: multilineText,
      }),
    );
  });

  it("parses shell-quoted arguments emitted by Armada BotCommandComposer", async () => {
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    const handler = vi.fn();
    bot.registerCommand("faq", handler);

    await bot.processMessage('/faq "1" "with \\"escaped\\" quotes"', SENDER_PUBKEY, "event-quoted");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "faq",
        args: ["1", 'with "escaped" quotes'],
      }),
    );
  });

  it("builds and publishes a validated Kind 10304 Bot Command Manifest while honoring includeInManifest", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });
    bot
      .registerCommand("ping", () => undefined, {
        description: "Ping a Lightning node over clearnet",
        args: [
          {
            name: "pubkey",
            type: "string",
            description: "66-char compressed secp256k1 node pubkey",
            required: true,
          },
        ],
      })
      .registerCommand("faq", () => undefined, {
        description: "Show TunnelSats FAQ topics",
        args: [
          {
            name: "topic",
            type: "choice",
            description: "FAQ topic number (1-11)",
            required: false,
            choices: ["1", "2", "3"],
          },
        ],
      })
      .registerCommand("setwelcome", () => undefined, {
        description: "Update welcome template",
        includeInManifest: false,
      });

    expect(bot.getCommandManifest()).toEqual({
      v: 1,
      commands: [
        {
          name: "ping",
          description: "Ping a Lightning node over clearnet",
          args: [
            {
              name: "pubkey",
              type: "string",
              description: "66-char compressed secp256k1 node pubkey",
              required: true,
              choices: [],
            },
          ],
        },
        {
          name: "faq",
          description: "Show TunnelSats FAQ topics",
          args: [
            {
              name: "topic",
              type: "choice",
              description: "FAQ topic number (1-11)",
              required: false,
              choices: ["1", "2", "3"],
            },
          ],
        },
      ],
    });

    await bot.start();
    const published = await bot.publishBotManifest();
    expect(published).toBe(true);
    expect(relayPoolMocks.publish).toHaveBeenCalledTimes(TEST_RELAYS.length);
    const manifestEvent = relayPoolMocks.publish.mock.calls[0][0] as NostrEvent;
    expect(manifestEvent.kind).toBe(10304);
    expect(manifestEvent.pubkey).toBe(bot.getPublicKeyHex());
    expect(JSON.parse(manifestEvent.content)).toEqual(bot.getCommandManifest());
  });

  it("validates Armada Kind 10304 manifest constraints on command registration", () => {
    const bot = new NostrCommunityBot({ nsec: TEST_SECRET_HEX, relays: TEST_RELAYS });

    expect(() =>
      bot.registerCommand("badorder", () => undefined, {
        description: "Optional before required",
        args: [
          { name: "opt", type: "string", required: false },
          { name: "req", type: "string", required: true },
        ],
      }),
    ).toThrow(/Required arguments must precede optional arguments/);

    expect(() =>
      bot.registerCommand("badchoice", () => undefined, {
        description: "Choice without choices",
        args: [{ name: "topic", type: "choice" }],
      }),
    ).toThrow(/must define 1\.\.32 choices/);

    expect(() =>
      bot.registerCommand("nonchoice", () => undefined, {
        description: "String with choices",
        args: [{ name: "topic", type: "string", choices: ["a"] }],
      }),
    ).toThrow(/cannot define choices/);
  });

  it("non-destructively merges bot: true into existing Kind 0 profile metadata and fails closed when missing", async () => {
    const existingMetadata = {
      display_name: "TunnelSats",
      name: "TunnelSats",
      picture: "https://example.com/pic.png",
      banner: "https://example.com/banner.jpg",
      about: "Lightning Hybrid Mode",
      lud06: "lnurl1example",
      lud16: "info@ln.tunnelsats.com",
      website: "https://tunnelsats.com",
      nip05: "tunnelsats@tunnelsats.com",
    };
    const existingKind0 = finalizeEvent(
      {
        kind: 0,
        created_at: 1_767_885_809,
        tags: [["client", "test"]],
        content: JSON.stringify(existingMetadata),
      },
      BOT_SECRET,
    );

    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(0)) {
        queueMicrotask(() => {
          params.onevent?.(existingKind0);
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });

    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
      botManifest: { enabled: true, publishBotProfileFlag: true },
    });
    bot.registerCommand("help", () => undefined, {
      description: "Show available commands",
    });

    await bot.start();

    const publishedEvents = relayPoolMocks.publish.mock.calls.map(
      (call) => call[0] as NostrEvent,
    );
    const kind0Event = publishedEvents.find((event) => event.kind === 0);
    const kind10304Event = publishedEvents.find((event) => event.kind === 10304);

    expect(kind0Event).toBeDefined();
    expect(kind0Event?.tags).toEqual([["client", "test"]]);
    expect(kind0Event?.created_at).toBeGreaterThan(existingKind0.created_at);
    expect(JSON.parse(kind0Event!.content)).toEqual({
      ...existingMetadata,
      bot: true,
    });
    expect(kind10304Event).toBeDefined();
  });

  it("refuses to publish a blank Kind 0 profile when no existing Kind 0 is found on relays", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    relayPoolMocks.subscribe.mockImplementation((filters, params) => {
      if (filters[0]?.kinds?.includes(0)) {
        queueMicrotask(() => {
          params.oneose?.();
        });
      }
      return { close: vi.fn() };
    });

    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
    });
    await bot.start();

    const updated = await bot.ensureBotProfileFlag();
    expect(updated).toBe(false);
    expect(relayPoolMocks.publish).not.toHaveBeenCalled();
  });
});

