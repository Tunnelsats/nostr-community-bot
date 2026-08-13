import { getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { NostrBotConfig, CommandHandler, CommandContext } from "./types.js";
import { parseSecretKey, parseCommand } from "./event-utils.js";
import { RelayConnectionManager } from "./relay-connection-manager.js";
import type { RelayConnectionStatus } from "./types.js";
import type { NostrEvent } from "nostr-tools/pure";
import { createDirectMessageReply, unwrapDirectMessage } from "./nip17-dm.js";

const PROCESSED_EVENT_CACHE_LIMIT = 1_024;

export class NostrCommunityBot {
  private secretKey: Uint8Array;
  private pubkeyHex: string;
  private relays: string[];
  private commands: Map<string, CommandHandler> = new Map();
  private relayConnections: RelayConnectionManager;
  private processedEventIds = new Set<string>();
  private acceptingRelayEvents = false;

  constructor(config: NostrBotConfig) {
    if (!config.nsec) {
      throw new Error("NostrBotConfig error: 'nsec' secret key is required.");
    }
    if (!config.relays || config.relays.length === 0) {
      throw new Error("NostrBotConfig error: at least one relay URL is required.");
    }

    this.secretKey = parseSecretKey(config.nsec);
    this.pubkeyHex = getPublicKey(this.secretKey);
    this.relays = [...new Set(config.relays)];
    this.relayConnections = new RelayConnectionManager(this.relays);
    this.relayConnections.registerSubscription({ kinds: [1059], "#p": [this.pubkeyHex] }, (event) =>
      this.handleGiftWrap(event),
    );
  }

  public getPublicKeyHex(): string {
    return this.pubkeyHex;
  }

  public getPublicKeyNpub(): string {
    return nip19.npubEncode(this.pubkeyHex);
  }

  public getRelays(): string[] {
    return [...this.relays];
  }

  public getRelayStatuses(): RelayConnectionStatus[] {
    return this.relayConnections.getRelayStatuses();
  }

  public registerCommand(name: string, handler: CommandHandler): this {
    const cleanName = name.trim().toLowerCase().replace(/^\//, "");
    if (!cleanName) {
      throw new Error("Command name cannot be empty.");
    }
    this.commands.set(cleanName, handler);
    return this;
  }

  public getRegisteredCommands(): string[] {
    return Array.from(this.commands.keys());
  }

  public async processMessage(
    text: string,
    senderPubkey: string,
    eventId: string,
    replyFn?: (msg: string) => Promise<void>,
  ): Promise<boolean> {
    const parsed = parseCommand(text);
    if (!parsed) {
      return false;
    }

    const handler = this.commands.get(parsed.command);
    if (!handler) {
      return false;
    }

    const defaultReply = replyFn || (async () => {});
    const ctx: CommandContext = {
      command: parsed.command,
      args: parsed.args,
      senderPubkey,
      eventId,
      reply: defaultReply,
    };

    await handler(ctx);
    return true;
  }

  public async start(): Promise<void> {
    this.acceptingRelayEvents = true;
    try {
      await this.relayConnections.start();
    } catch (error) {
      this.acceptingRelayEvents = false;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.acceptingRelayEvents = false;
    try {
      await this.relayConnections.stop();
    } finally {
      this.processedEventIds.clear();
    }
  }

  private rememberEvent(eventId: string): boolean {
    if (this.processedEventIds.has(eventId)) {
      return false;
    }

    if (this.processedEventIds.size >= PROCESSED_EVENT_CACHE_LIMIT) {
      const oldestEventId = this.processedEventIds.values().next().value;
      if (oldestEventId) {
        this.processedEventIds.delete(oldestEventId);
      }
    }
    this.processedEventIds.add(eventId);
    return true;
  }

  private async handleGiftWrap(event: NostrEvent): Promise<void> {
    if (!this.acceptingRelayEvents) {
      return;
    }

    let rumor;
    try {
      rumor = unwrapDirectMessage(event, this.secretKey, this.pubkeyHex);
    } catch {
      return;
    }

    if (!this.acceptingRelayEvents || !this.rememberEvent(event.id)) {
      return;
    }

    const reply = async (message: string): Promise<void> => {
      const response = createDirectMessageReply(this.secretKey, rumor.pubkey, message, rumor.id);
      await this.relayConnections.publish(response);
    };

    await this.processMessage(rumor.content, rumor.pubkey, rumor.id, reply);
  }
}
