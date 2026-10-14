import { getPublicKey, verifyEvent } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import {
  NostrBotConfig,
  CommandHandler,
  CommandContext,
  type CommandRegistrationOptions,
  type ConcordChannelMentionHandler,
  type ConcordMemberJoinHandler,
  type ConcordRoleType,
  type ProcessedEventStore,
  type RelayConnectionStatus,
} from "./types.js";
import { parseSecretKey, parseCommand } from "./event-utils.js";
import { RelayConnectionManager } from "./relay-connection-manager.js";
import type { NostrEvent } from "nostr-tools/pure";
import {
  createDirectMessage,
  createDirectMessageReply,
  unwrapDirectInvite,
  unwrapDirectMessage,
} from "./nip17-dm.js";
import {
  resolveHostname,
  validateDmRelayUrl,
  type HostnameResolver,
} from "./dm-relays.js";
import {
  ConcordCommunityManager,
  DEFAULT_CHANNEL_ALLOWED_COMMANDS,
  type ChannelCommandMetadata,
} from "./concord-manager.js";

export { DEFAULT_CHANNEL_ALLOWED_COMMANDS };

const PROCESSED_EVENT_CACHE_LIMIT = 1_024;
const DM_RELAY_CACHE_TTL_MS = 5 * 60 * 1_000;
const DM_RELAY_CACHE_LIMIT = 1_024;
const MAX_DM_RELAYS = 3;
const MAX_DM_RELAY_TAGS = 64;
const MAX_DM_RELAY_TAG_VALUES = 4;
const MAX_DM_RELAY_TAG_VALUE_LENGTH = 2_048;
const MAX_DM_RELAY_CONTENT_LENGTH = 1_024;
const DIRECT_MESSAGE_NOT_READY = "Nostr direct message recipient is not ready";
const DEFAULT_DM_OFFLINE_GRACE_SECONDS = 5 * 60;
const MAX_DM_OFFLINE_GRACE_SECONDS = 7 * 24 * 60 * 60;
const NIP59_GIFT_WRAP_BACKDATE_SECONDS = 2 * 24 * 60 * 60;
const MAX_DM_FUTURE_SKEW_SECONDS = 5 * 60;

interface DmRelayCacheEntry {
  expiresAt: number;
  relays: string[];
}

export class NostrCommunityBot {
  private secretKey: Uint8Array;
  private pubkeyHex: string;
  private relays: string[];
  private commands: Map<string, CommandHandler> = new Map();
  private channelCommandPermissions: Map<string, boolean> = new Map();
  private relayConnections: RelayConnectionManager;
  private processedEventIds = new Set<string>();
  private acceptingRelayEvents = false;
  private readonly hostnameResolver: HostnameResolver;
  private readonly dmRelayCache = new Map<string, DmRelayCacheEntry>();
  private readonly concordManager: ConcordCommunityManager | null;
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
    this.hostnameResolver = config.resolveHostname ?? resolveHostname;
    this.relayConnections = new RelayConnectionManager(
      this.relays,
      undefined,
      this.hostnameResolver,
    );
    this.concordManager = config.concord?.enabled
      ? new ConcordCommunityManager({
          secretKey: this.secretKey,
          pubkey: this.pubkeyHex,
          relayTransport: this.relayConnections,
          processMessage: (text, senderPubkey, eventId, reply, metadata) =>
            this.processMessage(text, senderPubkey, eventId, reply, metadata),
          isCommandAllowedInChannel: (command) => this.isCommandAllowedInChannel(command),
          isFreshEvent: (createdAt) => this.isFreshDirectMessage(createdAt),
          persistEventAcceptance: (eventId) => this.persistEventAcceptance(eventId),
          sendDirectMessage: (recipientPubkey, message) =>
            this.sendDirectMessage(recipientPubkey, message),
          store: config.concord.store,
          defaultChannelId: config.concord.defaultChannelId,
          onMemberJoin: config.concord.onMemberJoin,
          onChannelMention: config.concord.onChannelMention,
        })
      : null;
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

  public registerCommand(
    name: string,
    handler: CommandHandler,
    options?: CommandRegistrationOptions,
  ): this {
    const cleanName = name.trim().toLowerCase().replace(/^\//, "");
    if (!cleanName) {
      throw new Error("Command name cannot be empty.");
    }
    this.commands.set(cleanName, handler);
    const allowInChannel =
      options?.allowInChannel ?? DEFAULT_CHANNEL_ALLOWED_COMMANDS.has(cleanName);
    this.channelCommandPermissions.set(cleanName, allowInChannel);
    return this;
  }

  public isCommandAllowedInChannel(command: string): boolean {
    const cleanName = command.trim().toLowerCase().replace(/^\//, "");
    return (
      this.channelCommandPermissions.get(cleanName) ??
      DEFAULT_CHANNEL_ALLOWED_COMMANDS.has(cleanName)
    );
  }

  public onMemberJoin(handler: ConcordMemberJoinHandler): this {
    this.concordManager?.setOnMemberJoin(handler);
    return this;
  }

  public onChannelMention(handler: ConcordChannelMentionHandler): this {
    this.concordManager?.setOnChannelMention(handler);
    return this;
  }

  public async publishConcordChannelMessage(
    communityId: string,
    channelId: string,
    message: string,
    extraTags?: string[][],
  ): Promise<void> {
    if (!this.acceptingRelayEvents || !this.concordManager) {
      throw new Error("Concord community manager is not running");
    }
    await this.concordManager.publishChannelMessage(
      communityId,
      channelId,
      message,
      extraTags,
    );
  }

  public getConcordMemberRole(
    memberPubkey: string,
    channelId?: string,
    communityId?: string,
  ): ConcordRoleType {
    return (
      this.concordManager?.getMemberRole(memberPubkey, channelId, communityId) ??
      "member"
    );
  }

  public getRegisteredCommands(): string[] {
    return Array.from(this.commands.keys());
  }

  public async processMessage(
    text: string,
    senderPubkey: string,
    eventId: string,
    replyFn?: (msg: string) => Promise<void>,
    metadata?: ChannelCommandMetadata,
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
    const resolvedRole =
      metadata?.senderRole ??
      this.concordManager?.getMemberRole(
        senderPubkey,
        metadata?.channelId,
        metadata?.communityId,
      );
    const resolvedIsModerator =
      metadata?.isModerator ??
      (resolvedRole !== undefined
        ? resolvedRole === "owner" ||
          resolvedRole === "admin" ||
          resolvedRole === "moderator"
        : undefined);
    const ctx: CommandContext = {
      command: parsed.command,
      args: parsed.args,
      rawText: text,
      senderPubkey,
      eventId,
      reply: defaultReply,
      ...(metadata ?? {}),
      ...(resolvedRole !== undefined ? { senderRole: resolvedRole } : {}),
      ...(resolvedIsModerator !== undefined
        ? { isModerator: resolvedIsModerator }
        : {}),
    };

    await handler(ctx);
    return true;
  }

  public async start(): Promise<void> {
    this.acceptingRelayEvents = true;
    try {
      await this.relayConnections.start();
      if (this.concordManager) {
        await this.concordManager.restoreCommunities();
      }
    } catch (error) {
      this.acceptingRelayEvents = false;
      this.concordManager?.stop();
      await this.relayConnections.stop().catch(() => undefined);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.acceptingRelayEvents = false;
    this.concordManager?.stop();
    try {
      await this.relayConnections.stop();
    } finally {
      this.processedEventIds.clear();
      this.dmRelayCache.clear();
    }
  }

  public async sendDirectMessage(recipientPubkey: string, message: string): Promise<void> {
    if (!this.acceptingRelayEvents) {
      throw new Error("Nostr direct message sender is not running");
    }

    const [senderRelays, recipientRelays] = await Promise.all([
      this.getDmRelays(this.pubkeyHex),
      this.getDmRelays(recipientPubkey),
    ]);
    const copies = createDirectMessage(this.secretKey, recipientPubkey, message);

    await this.relayConnections.publishToRelays(copies.sender, senderRelays);
    await this.relayConnections.publishToRelays(copies.recipient, recipientRelays);
  }

  private async getDmRelays(pubkey: string): Promise<string[]> {
    const cached = this.dmRelayCache.get(pubkey);
    if (cached && cached.expiresAt > Date.now()) {
      try {
        const relays = await this.validateDmRelays(cached.relays);
        this.dmRelayCache.delete(pubkey);
        this.dmRelayCache.set(pubkey, cached);
        return relays;
      } catch {
        this.dmRelayCache.delete(pubkey);
        throw new Error(DIRECT_MESSAGE_NOT_READY);
      }
    }

    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error(DIRECT_MESSAGE_NOT_READY);
    const events = await this.relayConnections.query({
      kinds: [10050],
      authors: [pubkey],
      limit: 10,
    });
    const latest = events
      .filter(
        (event) =>
          event.kind === 10050 &&
          event.pubkey === pubkey &&
          this.isBoundedDmRelayEvent(event) &&
          verifyEvent(event),
      )
      .sort((left, right) => right.created_at - left.created_at)[0];
    if (!latest) throw new Error(DIRECT_MESSAGE_NOT_READY);

    const candidates = [
      ...new Set(
        latest.tags
          .filter((tag) => tag[0] === "relay" && typeof tag[1] === "string")
          .map((tag) => tag[1]),
      ),
    ];
    const relays = await this.validateDmRelays(candidates);

    if (this.dmRelayCache.size >= DM_RELAY_CACHE_LIMIT) {
      const oldestPubkey = this.dmRelayCache.keys().next().value;
      if (oldestPubkey) this.dmRelayCache.delete(oldestPubkey);
    }
    this.dmRelayCache.set(pubkey, {
      expiresAt: Date.now() + DM_RELAY_CACHE_TTL_MS,
      relays,
    });
    return [...relays];
  }

  private isBoundedDmRelayEvent(event: NostrEvent): boolean {
    if (typeof event.content !== "string" || !Array.isArray(event.tags)) {
      return false;
    }
    return (
      event.content.length <= MAX_DM_RELAY_CONTENT_LENGTH &&
      event.tags.length <= MAX_DM_RELAY_TAGS &&
      event.tags.every(
        (tag) =>
          Array.isArray(tag) &&
          tag.length <= MAX_DM_RELAY_TAG_VALUES &&
          tag.every(
            (value) =>
              typeof value === "string" &&
              value.length <= MAX_DM_RELAY_TAG_VALUE_LENGTH,
          ),
      )
    );
  }

  private async validateDmRelays(candidates: string[]): Promise<string[]> {
    if (candidates.length === 0 || candidates.length > MAX_DM_RELAYS) {
      throw new Error(DIRECT_MESSAGE_NOT_READY);
    }
    const validated = await Promise.all(
      candidates.map((url) => validateDmRelayUrl(url, this.hostnameResolver)),
    );
    if (validated.some((url) => url === null)) {
      throw new Error(DIRECT_MESSAGE_NOT_READY);
    }
    return validated as string[];
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
      if (!this.concordManager) return;
      if (this.processedEventIds.has(event.id)) return;
      try {
        const invite = unwrapDirectInvite(event, this.secretKey, this.pubkeyHex);
        if (!this.acceptingRelayEvents) return;
        await this.concordManager.acceptDirectInvite(invite);
        this.rememberEvent(event.id);
      } catch {
        return;
      }
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

    await this.processMessage(rumor.content, rumor.pubkey, rumor.id, reply, {
      transport: "dm",
    });
  }
}
