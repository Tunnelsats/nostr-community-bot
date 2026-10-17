import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import {
  NostrBotConfig,
  CommandHandler,
  CommandContext,
  type BotCommandArgSpec,
  type BotCommandArgType,
  type BotCommandManifest,
  type BotCommandManifestArg,
  type BotCommandManifestEntry,
  type BotManifestConfig,
  type CommandRegistrationOptions,
  type ConcordChannelMentionHandler,
  type ConcordMemberJoinHandler,
  type ConcordRoleType,
  type ProcessedEventStore,
  type RelayConnectionStatus,
} from "./types.js";
import { parseSecretKey, parseCommand } from "./event-utils.js";
import {
  RelayConnectionManager,
  validatePublicRelayAddress,
} from "./relay-connection-manager.js";
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

export const BOT_MANIFEST_KIND = 10304;
export const DEFAULT_BOT_DISCOVERY_RELAYS = [
  "wss://purplepag.es",
  "wss://relay.nostr.band",
  "wss://nos.lol",
] as const;

const MANIFEST_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MAX_MANIFEST_COMMANDS = 64;
const MAX_MANIFEST_ARGS = 8;
const MAX_MANIFEST_CHOICES = 32;
const MAX_MANIFEST_CHOICE_BYTES = 32;
const MAX_MANIFEST_DESCRIPTION_BYTES = 200;
const MAX_MANIFEST_BYTES = 32_768;
const MAX_PROFILE_CONTENT_BYTES = 65_536;
const MAX_DISCOVERY_RELAYS = 16;
const VALID_MANIFEST_ARG_TYPES = new Set<BotCommandArgType>([
  "string",
  "int",
  "number",
  "bool",
  "user",
  "choice",
]);

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function buildManifestArg(spec: BotCommandArgSpec, commandName: string): BotCommandManifestArg {
  const argName = spec.name.trim();
  if (!MANIFEST_NAME_RE.test(argName)) {
    throw new Error(
      `Invalid argument name "${spec.name}" for command "/${commandName}": must match /^[a-z0-9_-]{1,32}$/.`,
    );
  }
  if (!VALID_MANIFEST_ARG_TYPES.has(spec.type)) {
    throw new Error(
      `Invalid argument type "${String(spec.type)}" for "${argName}" in command "/${commandName}".`,
    );
  }
  const description = (spec.description ?? "").trim();
  if (utf8ByteLength(description) > MAX_MANIFEST_DESCRIPTION_BYTES) {
    throw new Error(
      `Argument description for "${argName}" in command "/${commandName}" exceeds ${MAX_MANIFEST_DESCRIPTION_BYTES} bytes.`,
    );
  }

  let choices: string[] = [];
  if (spec.type === "choice") {
    if (!Array.isArray(spec.choices) || spec.choices.length === 0 || spec.choices.length > MAX_MANIFEST_CHOICES) {
      throw new Error(
        `Choice argument "${argName}" in command "/${commandName}" must define 1..${MAX_MANIFEST_CHOICES} choices.`,
      );
    }
    const seenChoices = new Set<string>();
    choices = spec.choices.map((choice) => {
      const normalized = choice.trim();
      const bytes = utf8ByteLength(normalized);
      if (bytes === 0 || bytes > MAX_MANIFEST_CHOICE_BYTES) {
        throw new Error(
          `Choice "${choice}" for argument "${argName}" in command "/${commandName}" must be 1..${MAX_MANIFEST_CHOICE_BYTES} bytes.`,
        );
      }
      if (seenChoices.has(normalized)) {
        throw new Error(
          `Duplicate choice "${normalized}" for argument "${argName}" in command "/${commandName}".`,
        );
      }
      seenChoices.add(normalized);
      return normalized;
    });
  } else if (spec.choices && spec.choices.length > 0) {
    throw new Error(
      `Argument "${argName}" in command "/${commandName}" cannot define choices when type is "${spec.type}".`,
    );
  }

  return {
    name: argName,
    type: spec.type,
    description,
    required: spec.required ?? false,
    choices,
  };
}

function buildManifestEntry(
  cleanName: string,
  options: CommandRegistrationOptions,
): BotCommandManifestEntry {
  if (!MANIFEST_NAME_RE.test(cleanName)) {
    throw new Error(
      `Invalid manifest command name "${cleanName}": must match /^[a-z0-9_-]{1,32}$/.`,
    );
  }
  const description = (options.description ?? "").trim();
  const descriptionBytes = utf8ByteLength(description);
  if (descriptionBytes === 0 || descriptionBytes > MAX_MANIFEST_DESCRIPTION_BYTES) {
    throw new Error(
      `Manifest description for command "/${cleanName}" must be 1..${MAX_MANIFEST_DESCRIPTION_BYTES} bytes.`,
    );
  }
  const rawArgs = options.args ?? [];
  if (rawArgs.length > MAX_MANIFEST_ARGS) {
    throw new Error(
      `Command "/${cleanName}" defines ${rawArgs.length} args (max ${MAX_MANIFEST_ARGS}).`,
    );
  }

  const seenArgNames = new Set<string>();
  const args = rawArgs.map((argSpec) => {
    const built = buildManifestArg(argSpec, cleanName);
    if (seenArgNames.has(built.name)) {
      throw new Error(
        `Duplicate argument "${built.name}" in command "/${cleanName}".`,
      );
    }
    seenArgNames.add(built.name);
    return built;
  });

  const firstOptionalIndex = args.findIndex((arg) => !arg.required);
  if (
    firstOptionalIndex !== -1 &&
    args.slice(firstOptionalIndex).some((arg) => arg.required)
  ) {
    throw new Error(
      `Required arguments must precede optional arguments in command "/${cleanName}".`,
    );
  }

  return {
    name: cleanName,
    description,
    args,
  };
}

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
  private discoveryRelays: string[];
  private commands: Map<string, CommandHandler> = new Map();
  private channelCommandPermissions: Map<string, boolean> = new Map();
  private commandManifestEntries: Map<string, BotCommandManifestEntry> = new Map();
  private relayConnections: RelayConnectionManager;
  private processedEventIds = new Set<string>();
  private acceptingRelayEvents = false;
  private readonly hostnameResolver: HostnameResolver;
  private readonly dmRelayCache = new Map<string, DmRelayCacheEntry>();
  private readonly concordManager: ConcordCommunityManager | null;
  private readonly botManifestConfig: BotManifestConfig | undefined;
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
    const rawDiscoveryRelays =
      config.botManifest?.discoveryRelays !== undefined
        ? config.botManifest.discoveryRelays
        : config.botManifest?.enabled
          ? [...DEFAULT_BOT_DISCOVERY_RELAYS]
          : [];
    const normalizedDiscoveryRelays = rawDiscoveryRelays.map((entry) => {
      const trimmed = typeof entry === "string" ? entry.trim() : "";
      try {
        validatePublicRelayAddress(trimmed);
      } catch {
        throw new Error("NostrBotConfig error: invalid discovery relay URL.");
      }
      return trimmed;
    });
    const deduplicatedDiscoveryRelays = [...new Set(normalizedDiscoveryRelays)];
    if (deduplicatedDiscoveryRelays.length > MAX_DISCOVERY_RELAYS) {
      throw new Error(
        `NostrBotConfig error: at most ${MAX_DISCOVERY_RELAYS} discovery relays are allowed.`,
      );
    }
    this.discoveryRelays = deduplicatedDiscoveryRelays;

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
    this.botManifestConfig = config.botManifest;
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
          channelReadyTimeoutMs: config.concord.channelReadyTimeoutMs,
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

  public getDiscoveryRelays(): string[] {
    return [...this.discoveryRelays];
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
    const shouldIncludeInManifest =
      options?.includeInManifest !== false &&
      typeof options?.description === "string" &&
      options.description.trim().length > 0;
    if (shouldIncludeInManifest && options) {
      if (
        !this.commandManifestEntries.has(cleanName) &&
        this.commandManifestEntries.size >= MAX_MANIFEST_COMMANDS
      ) {
        throw new Error(
          `Cannot register more than ${MAX_MANIFEST_COMMANDS} manifest commands.`,
        );
      }
      const entry = buildManifestEntry(cleanName, options);
      this.commandManifestEntries.set(cleanName, entry);
    } else {
      this.commandManifestEntries.delete(cleanName);
    }

    this.commands.set(cleanName, handler);
    const allowInChannel =
      options?.allowInChannel ?? DEFAULT_CHANNEL_ALLOWED_COMMANDS.has(cleanName);
    this.channelCommandPermissions.set(cleanName, allowInChannel);
    return this;
  }

  public getCommandManifest(): BotCommandManifest {
    return {
      v: 1,
      commands: Array.from(this.commandManifestEntries.values()).map((entry) => ({
        name: entry.name,
        description: entry.description,
        args: entry.args.map((arg) => ({
          name: arg.name,
          type: arg.type,
          description: arg.description,
          required: arg.required,
          choices: [...arg.choices],
        })),
      })),
    };
  }

  private getExternalDiscoveryRelays(): string[] {
    if (this.discoveryRelays.length === 0) {
      return [];
    }
    const managedCanonicalUrls = new Set<string>();
    for (const status of this.relayConnections.getRelayStatuses()) {
      try {
        managedCanonicalUrls.add(new URL(status.url).toString());
      } catch {
        managedCanonicalUrls.add(status.url);
      }
    }
    return this.discoveryRelays.filter((url) => {
      try {
        return !managedCanonicalUrls.has(new URL(url).toString());
      } catch {
        return !managedCanonicalUrls.has(url);
      }
    });
  }

  private async publishToDiscoveryRelays(event: NostrEvent): Promise<void> {
    const targets = this.getExternalDiscoveryRelays();
    if (targets.length === 0 || !this.acceptingRelayEvents) {
      return;
    }
    try {
      await this.relayConnections.publishToRelays(event, targets);
    } catch {
      console.warn(
        `[Nostr] Best-effort Kind ${event.kind} publication to discovery relays did not succeed`,
      );
    }
  }

  public async publishBotManifest(): Promise<boolean> {
    if (!this.acceptingRelayEvents) {
      throw new Error("Nostr bot is not running");
    }
    const manifest = this.getCommandManifest();
    if (manifest.commands.length === 0) {
      return false;
    }
    const content = JSON.stringify(manifest);
    if (utf8ByteLength(content) > MAX_MANIFEST_BYTES) {
      throw new Error(
        `Kind ${BOT_MANIFEST_KIND} Bot Command Manifest exceeds ${MAX_MANIFEST_BYTES} bytes.`,
      );
    }
    const event = finalizeEvent(
      {
        kind: BOT_MANIFEST_KIND,
        created_at: Math.floor(Date.now() / 1_000),
        tags: [],
        content,
      },
      this.secretKey,
    );
    await this.relayConnections.publish(event);
    await this.publishToDiscoveryRelays(event);
    return true;
  }

  public async ensureBotProfileFlag(): Promise<boolean> {
    if (!this.acceptingRelayEvents) {
      throw new Error("Nostr bot is not running");
    }
    const events = await this.relayConnections.query({
      kinds: [0],
      authors: [this.pubkeyHex],
      limit: 10,
    });
    const candidates = events
      .filter(
        (event) =>
          event.kind === 0 &&
          event.pubkey === this.pubkeyHex &&
          typeof event.content === "string" &&
          utf8ByteLength(event.content) <= MAX_PROFILE_CONTENT_BYTES &&
          Array.isArray(event.tags) &&
          verifyEvent(event),
      )
      .sort((left, right) =>
        right.created_at !== left.created_at
          ? right.created_at - left.created_at
          : right.id.localeCompare(left.id),
      );

    let latestEvent: NostrEvent | undefined;
    let parsedMetadata: Record<string, unknown> | undefined;
    for (const candidate of candidates) {
      try {
        const parsed: unknown = JSON.parse(candidate.content);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          Object.keys(parsed).length > 0
        ) {
          latestEvent = candidate;
          parsedMetadata = parsed as Record<string, unknown>;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!latestEvent || !parsedMetadata) {
      console.warn(
        "[Nostr] Skipping Kind 0 bot flag update: no existing Kind 0 profile metadata found on connected relays",
      );
      return false;
    }

    if (parsedMetadata.bot === true) {
      await this.relayConnections.publish(latestEvent);
      await this.publishToDiscoveryRelays(latestEvent);
      return true;
    }

    const updatedProfile = {
      ...parsedMetadata,
      bot: true,
    };
    const updatedEvent = finalizeEvent(
      {
        kind: 0,
        created_at: Math.max(Math.floor(Date.now() / 1_000), latestEvent.created_at + 1),
        tags: latestEvent.tags.map((tag) => [...tag]),
        content: JSON.stringify(updatedProfile),
      },
      this.secretKey,
    );
    await this.relayConnections.publish(updatedEvent);
    await this.publishToDiscoveryRelays(updatedEvent);
    return true;
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
    options?: { waitTimeoutMs?: number },
  ): Promise<void> {
    if (!this.acceptingRelayEvents || !this.concordManager) {
      throw new Error("Concord community manager is not running");
    }
    await this.concordManager.publishChannelMessage(
      communityId,
      channelId,
      message,
      extraTags,
      options,
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

    if (this.botManifestConfig?.enabled) {
      await this.syncBotProfileAndManifest();
    }
  }

  private async syncBotProfileAndManifest(): Promise<void> {
    if (!this.acceptingRelayEvents || !this.botManifestConfig?.enabled) {
      return;
    }
    if (this.botManifestConfig.publishBotProfileFlag !== false) {
      try {
        await this.ensureBotProfileFlag();
      } catch (error) {
        console.warn("[Nostr] Failed to ensure Kind 0 bot profile flag:", error);
      }
    }
    try {
      await this.publishBotManifest();
    } catch (error) {
      console.warn("[Nostr] Failed to publish Kind 10304 bot command manifest:", error);
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
        if (this.botManifestConfig?.enabled) {
          await this.syncBotProfileAndManifest();
        }
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
