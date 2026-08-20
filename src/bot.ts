import { getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import {
  NostrBotConfig,
  CommandHandler,
  CommandContext,
  type ProcessedEventStore,
} from "./types.js";
import { parseSecretKey, parseCommand } from "./event-utils.js";
import { RelayConnectionManager } from "./relay-connection-manager.js";
import type { RelayConnectionStatus } from "./types.js";
import type { NostrEvent } from "nostr-tools/pure";
import { createDirectMessageReply, unwrapDirectMessage } from "./nip17-dm.js";

const PROCESSED_EVENT_CACHE_LIMIT = 1_024;
const DEFAULT_DM_OFFLINE_GRACE_SECONDS = 5 * 60;
const MAX_DM_OFFLINE_GRACE_SECONDS = 7 * 24 * 60 * 60;
const NIP59_GIFT_WRAP_BACKDATE_SECONDS = 2 * 24 * 60 * 60;
const MAX_DM_FUTURE_SKEW_SECONDS = 5 * 60;

export class NostrCommunityBot {
  private secretKey: Uint8Array;
  private pubkeyHex: string;
  private relays: string[];
  private commands: Map<string, CommandHandler> = new Map();
  private relayConnections: RelayConnectionManager;
  private processedEventIds = new Set<string>();
  private acceptingRelayEvents = false;
  private readonly directMessageCutoff: number;
  private readonly directMessageOfflineGraceSeconds: number;
  private readonly processedEventStore: ProcessedEventStore | undefined;

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
    const offlineGraceSeconds =
      config.directMessageReplay?.offlineGraceSeconds ?? DEFAULT_DM_OFFLINE_GRACE_SECONDS;
    if (
      !Number.isSafeInteger(offlineGraceSeconds) ||
      offlineGraceSeconds < 0 ||
      offlineGraceSeconds > MAX_DM_OFFLINE_GRACE_SECONDS
    ) {
      throw new Error(
        `NostrBotConfig error: direct-message offline grace must be an integer from 0 to ${MAX_DM_OFFLINE_GRACE_SECONDS}.`,
      );
    }
    const startupTime = Math.floor(Date.now() / 1_000);
    this.directMessageCutoff = startupTime - offlineGraceSeconds;
    this.directMessageOfflineGraceSeconds = offlineGraceSeconds;
    this.processedEventStore = config.directMessageReplay?.store;
    this.relayConnections = new RelayConnectionManager(this.relays);
    this.relayConnections.registerSubscription(
      {
        kinds: [1059],
        "#p": [this.pubkeyHex],
        since: Math.max(0, this.directMessageCutoff - NIP59_GIFT_WRAP_BACKDATE_SECONDS),
      },
      (event) => this.handleGiftWrap(event),
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

  private isFreshDirectMessage(createdAt: number): boolean {
    const now = Math.floor(Date.now() / 1_000);
    const activeCutoff = Math.max(
      this.directMessageCutoff,
      now - this.directMessageOfflineGraceSeconds,
    );
    return createdAt >= activeCutoff && createdAt <= now + MAX_DM_FUTURE_SKEW_SECONDS;
  }

  private async persistEventAcceptance(eventId: string): Promise<boolean> {
    if (!this.processedEventStore) {
      return true;
    }

    const processed = await this.processedEventStore.isProcessed(eventId);
    if (typeof processed !== "boolean") {
      throw new Error("Processed event store returned an invalid result");
    }
    if (processed) {
      return false;
    }

    const claimed = await this.processedEventStore.markProcessed(eventId);
    if (claimed !== undefined && typeof claimed !== "boolean") {
      throw new Error("Processed event store returned an invalid claim result");
    }
    return claimed !== false;
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

    if (
      !this.acceptingRelayEvents ||
      !this.isFreshDirectMessage(rumor.created_at) ||
      !this.rememberEvent(rumor.id)
    ) {
      return;
    }

    if (!(await this.persistEventAcceptance(rumor.id)) || !this.acceptingRelayEvents) {
      return;
    }

    const reply = async (message: string): Promise<void> => {
      const response = createDirectMessageReply(this.secretKey, rumor.pubkey, message, rumor.id);
      await this.relayConnections.publish(response);
    };

    await this.processMessage(rumor.content, rumor.pubkey, rumor.id, reply);
  }
}
