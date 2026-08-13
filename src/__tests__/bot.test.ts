import { beforeEach, describe, it, expect, vi } from "vitest";
import { nip17 } from "nostr-tools";
import { getPublicKey, type NostrEvent } from "nostr-tools/pure";
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

const TEST_NSEC = "nsec150qxe64t0skrml3lpk8kcdkm68l8hjje4ac60rumyj3r4neyfk8qtlv2jl";
const TEST_RELAYS = ["wss://relay.ditto.pub", "wss://relay.damus.io"];
const BOT_SECRET = Uint8Array.from(
  Buffer.from("a3c06ceaab7c2c3dfe3f0d8f6c36dbd1fe7bca59af71a78f9b24a23acf244d8e", "hex"),
);
const SENDER_SECRET = Uint8Array.from(
  Buffer.from("0beebd062ec8735f4243466049d7747ef5d6594ee838de147f8aab842b15e273", "hex"),
);
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
      nsec: TEST_NSEC,
      relays: TEST_RELAYS,
    });

    expect(bot.getPublicKeyHex()).toBe(
      "93929782974e6c9a9cccbc45ac30f1163792c2e74878eab7e7e2777d84354403",
    );
    expect(bot.getPublicKeyNpub()).toBe(
      "npub1jwff0q5hfekf48xvh3z6cv83zcme9sh8fpuw4dl8ufmhmpp4gspsmqg8ct",
    );
    expect(bot.getRelays()).toEqual(TEST_RELAYS);
  });

  it("registers and executes commands", async () => {
    const bot = new NostrCommunityBot({
      nsec: TEST_NSEC,
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
      nsec: TEST_NSEC,
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
      nsec: TEST_NSEC,
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
      nsec: TEST_NSEC,
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
      nsec: TEST_NSEC,
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });

    await bot.start();

    expect(relayPoolMocks.subscribe).toHaveBeenCalledTimes(TEST_RELAYS.length);
    for (const [filters] of relayPoolMocks.subscribe.mock.calls) {
      expect(filters).toEqual([{ kinds: [1059], "#p": [bot.getPublicKeyHex()] }]);
    }
  });

  it("dispatches a validated encrypted command with authenticated context identity", async () => {
    relayPoolMocks.ensureRelay.mockImplementation(async () => createMockRelay());
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
    const bot = new NostrCommunityBot({ nsec: TEST_NSEC, relays: TEST_RELAYS });
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
