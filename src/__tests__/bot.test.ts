import { beforeEach, describe, it, expect, vi } from "vitest";
import { NostrCommunityBot } from "../bot.js";

const relayPoolMocks = vi.hoisted(() => ({
  ensureRelay: vi.fn(),
  close: vi.fn(),
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

beforeEach(() => {
  relayPoolMocks.ensureRelay.mockReset();
  relayPoolMocks.close.mockReset();
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
    relayPoolMocks.ensureRelay.mockResolvedValue({ onclose: null });
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
    relayPoolMocks.ensureRelay.mockResolvedValue({ onclose: null });
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
    relayPoolMocks.ensureRelay.mockResolvedValue({ onclose: null });
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
});
