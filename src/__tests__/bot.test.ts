import { beforeEach, describe, it, expect, vi } from "vitest";
import { nip17, nip19, nip59 } from "nostr-tools";
import { generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import { NostrCommunityBot } from "../bot.js";
import { unwrapDirectMessage } from "../nip17-dm.js";

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

function emitSubscriptionEvent(callIndex: number, event: NostrEvent): void {
  const params = relayPoolMocks.subscribe.mock.calls[callIndex]?.[1] as
    { onevent?: (received: NostrEvent) => void } | undefined;
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

  it("registers and executes commands", async () => {
    const bot = new NostrCommunityBot({
      nsec: TEST_SECRET_HEX,
      relays: TEST_RELAYS,
    });

    const handler = vi.fn(async (ctx) => {
      await ctx.reply(`Pong! Arg: ${ctx.args[0]}`);
    });

    bot.registerCommand("ping", handler);
    expect(bot.getRegisteredCommands()).toContain("ping");

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
});
