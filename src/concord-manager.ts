import { nip19, type Filter, type NostrEvent } from "nostr-tools";
import { parseCommand } from "./event-utils.js";
import type {
  CommandContext,
  ConcordChannelMentionHandler,
  ConcordCommunityStore,
  ConcordMemberJoinHandler,
} from "./types.js";
import {
  CONCORD_CONTROL_KIND,
  CONCORD_DIRECT_INVITE_KIND,
  CONCORD_JOIN_KIND,
  CONCORD_STREAM_KIND,
  CONCORD_EPHEMERAL_STREAM_KIND,
  createConcordStreamEvent,
  decodeConcordStreamEvent,
  deriveConcordGroupKey,
  foldConcordControl,
  hasWireGuardLeak,
  validateConcordInvite,
  type ConcordControlEdition,
  type ConcordGroupKey,
  type ConcordInviteBundle,
  type ConcordRumor,
  type FoldedConcordControl,
} from "./concord.js";

export const CONCORD_PRIVACY_ADVISORY =
  "⚠️ WireGuard keys must not be shared in public channels. Your message was redacted for privacy.\n" +
  "Please send `/link <your_key>` in a private end-to-end encrypted DM to @TunnelSats.";

export const DEFAULT_CHANNEL_ALLOWED_COMMANDS = new Set([
  "ping",
  "info",
  "help",
  "welcome",
  "start",
  "faq",
  "donate",
  "servers",
  "pendingqueue",
]);

const MAX_COMMUNITIES = 16;
const MAX_PROCESSED_WRAPS = 4_096;
const MAX_PROCESSED_RUMORS = 4_096;
const MAX_ACCEPTED_INVITES = 4_096;
const MAX_CONTROL_EDITIONS = 4_096;
export const MAX_CONCORD_CHANNEL_SUBSCRIPTIONS = 256;

export type ChannelCommandMetadata = Pick<
  CommandContext,
  "transport" | "communityId" | "channelId" | "channelName" | "isModerator"
>;

export interface ConcordRelayTransport {
  addRelays(relays: string[]): Promise<void>;
  registerSubscription(
    filter: Filter,
    handler: (event: NostrEvent) => Promise<void> | void,
  ): () => void;
  publishToRelays(event: NostrEvent, relays: string[]): Promise<void>;
}

interface ConcordCommunityManagerOptions {
  secretKey: Uint8Array;
  pubkey: string;
  relayTransport: ConcordRelayTransport;
  processMessage(
    text: string,
    senderPubkey: string,
    eventId: string,
    reply: (message: string) => Promise<void>,
    metadata?: ChannelCommandMetadata,
  ): Promise<boolean>;
  isCommandAllowedInChannel?: (command: string) => boolean;
  isFreshEvent?: (createdAt: number) => boolean;
  persistEventAcceptance?: (eventId: string) => Promise<boolean>;
  sendDirectMessage?: (recipientPubkey: string, message: string) => Promise<void>;
  store?: ConcordCommunityStore;
  defaultChannelId?: string;
  onMemberJoin?: ConcordMemberJoinHandler;
  onChannelMention?: ConcordChannelMentionHandler;
  now?: () => number;
}

interface ChannelContext {
  channelId: string;
  epoch: number;
  group: ConcordGroupKey;
  source: "invite" | "public";
  name?: string;
  active: boolean;
  dispose: () => void;
}

interface CommunityState {
  bundle: ConcordInviteBundle;
  controlReadGroup: ConcordGroupKey;
  guestbookGroup: ConcordGroupKey;
  controlEditions: ConcordControlEdition[];
  control: FoldedConcordControl;
  controlDispose: () => void;
  guestbookDispose: () => void;
  channels: Map<string, ChannelContext>;
  joinPublished: boolean;
}

function emptyControl(bundle: ConcordInviteBundle): FoldedConcordControl {
  return foldConcordControl([], {
    communityId: bundle.community_id,
    owner: bundle.owner,
  });
}

function tagValue(tags: string[][], name: string): string | undefined {
  const matches = tags.filter((tag) => tag[0] === name);
  return matches.length === 1 ? matches[0][1] : undefined;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseControlEdition(rumor: ConcordRumor): ConcordControlEdition | null {
  const vsk = parseNonNegativeInteger(tagValue(rumor.tags, "vsk"));
  const eid = tagValue(rumor.tags, "eid");
  const version = parsePositiveInteger(tagValue(rumor.tags, "ev") ?? "1");
  const prev = tagValue(rumor.tags, "ep");
  if (vsk === null || version === null || !eid || !/^[0-9a-f]{64}$/.test(eid)) return null;
  if (prev !== undefined && !/^[0-9a-f]{64}$/.test(prev)) return null;
  return {
    author: rumor.pubkey,
    rumorId: rumor.id,
    vsk,
    eid,
    version,
    ...(prev !== undefined ? { prev } : {}),
    content: rumor.content,
  };
}

export class ConcordCommunityManager {
  private readonly secretKey: Uint8Array;
  private readonly pubkey: string;
  private readonly npub: string;
  private readonly relayTransport: ConcordRelayTransport;
  private readonly processMessage: ConcordCommunityManagerOptions["processMessage"];
  private readonly isCommandAllowedInChannel: (command: string) => boolean;
  private readonly isFreshEvent: (createdAt: number) => boolean;
  private readonly persistEventAcceptance: (eventId: string) => Promise<boolean>;
  private readonly sendDirectMessage?: (
    recipientPubkey: string,
    message: string,
  ) => Promise<void>;
  private readonly store?: ConcordCommunityStore;
  private readonly defaultChannelId?: string;
  private onMemberJoinHandler?: ConcordMemberJoinHandler;
  private onChannelMentionHandler?: ConcordChannelMentionHandler;
  private readonly now: () => number;
  private readonly communities = new Map<string, CommunityState>();
  private readonly processedWraps = new Set<string>();
  private readonly processedRumors = new Set<string>();
  private readonly acceptedInvites = new Set<string>();
  private inviteQueue: Promise<void> = Promise.resolve();
  private accepting = true;

  public constructor(options: ConcordCommunityManagerOptions) {
    this.secretKey = options.secretKey;
    this.pubkey = options.pubkey;
    this.npub = nip19.npubEncode(options.pubkey);
    this.relayTransport = options.relayTransport;
    this.processMessage = options.processMessage;
    this.isCommandAllowedInChannel =
      options.isCommandAllowedInChannel ??
      ((command: string) => DEFAULT_CHANNEL_ALLOWED_COMMANDS.has(command));
    this.isFreshEvent = options.isFreshEvent ?? (() => true);
    this.persistEventAcceptance = options.persistEventAcceptance ?? (async () => true);
    this.sendDirectMessage = options.sendDirectMessage;
    this.store = options.store;
    this.defaultChannelId = options.defaultChannelId;
    this.onMemberJoinHandler = options.onMemberJoin;
    this.onChannelMentionHandler = options.onChannelMention;
    this.now = options.now ?? Date.now;
  }

  public setOnMemberJoin(handler: ConcordMemberJoinHandler | undefined): void {
    this.onMemberJoinHandler = handler;
  }

  public setOnChannelMention(handler: ConcordChannelMentionHandler | undefined): void {
    this.onChannelMentionHandler = handler;
  }

  public async restoreCommunities(): Promise<void> {
    this.accepting = true;
    if (!this.store) return;
    const persistedList = await this.store.loadCommunities();
    for (const persisted of persistedList) {
      if (!this.accepting) return;
      const bundle = validateConcordInvite(persisted.bundle, 0);
      if (!bundle) continue;
      if (this.communities.has(bundle.community_id)) continue;
      if (this.communities.size >= MAX_COMMUNITIES) break;
      if (
        this.channelSubscriptionCount() + bundle.channels.length >
        MAX_CONCORD_CHANNEL_SUBSCRIPTIONS
      ) {
        continue;
      }

      await this.relayTransport.addRelays(bundle.relays);
      if (!this.accepting) return;
      const state = this.registerCommunityState(bundle, persisted.joinPublished);
      if (!state.joinPublished) {
        await this.publishJoin(bundle);
        state.joinPublished = true;
        await this.store.saveCommunity({
          bundle: state.bundle,
          joinPublished: true,
        });
      }
    }
  }

  public async acceptDirectInvite(rumor: ConcordRumor): Promise<void> {
    const task = this.inviteQueue.then(() => this.acceptDirectInviteSerial(rumor));
    this.inviteQueue = task.catch(() => undefined);
    return task;
  }

  private async acceptDirectInviteSerial(rumor: ConcordRumor): Promise<void> {
    if (
      !this.accepting ||
      rumor.kind !== CONCORD_DIRECT_INVITE_KIND ||
      this.acceptedInvites.has(rumor.id)
    ) {
      return;
    }
    console.log(`[Concord] Processing direct invite rumor ${rumor.id.slice(0, 8)}... from ${rumor.pubkey.slice(0, 8)}...`);
    let payload: unknown;
    try {
      payload = JSON.parse(rumor.content) as unknown;
    } catch {
      console.warn(`[Concord] Failed to parse direct invite payload in rumor ${rumor.id.slice(0, 8)}...`);
      return;
    }
    const bundle = validateConcordInvite(payload, this.now());
    if (!bundle) {
      console.warn(`[Concord] Direct invite validation failed for rumor ${rumor.id.slice(0, 8)}...`);
      return;
    }
    console.log(`[Concord] Accepted direct invite for community ${bundle.community_id.slice(0, 8)}... with ${bundle.channels.length} channel(s) across ${bundle.relays.length} relay(s)`);
    const existing = this.communities.get(bundle.community_id);
    if (existing) {
      if (
        existing.bundle.root_epoch !== bundle.root_epoch ||
        existing.bundle.community_root !== bundle.community_root ||
        existing.bundle.control_pk !== bundle.control_pk
      ) {
        return;
      }
      const newChannels = bundle.channels.filter(
        (channel) => !existing.bundle.channels.some((held) => held.id === channel.id),
      );
      if (
        this.channelSubscriptionCount() + newChannels.length >
        MAX_CONCORD_CHANNEL_SUBSCRIPTIONS
      ) {
        return;
      }
      await this.relayTransport.addRelays(bundle.relays);
      console.log(`[Concord] Community relay registration completed for ${bundle.relays.length} relay(s)`);
      if (!this.accepting) return;
      for (const channel of bundle.channels) {
        if (!existing.bundle.channels.some((held) => held.id === channel.id)) {
          existing.bundle.channels.push(channel);
          this.subscribeChannel(
            existing,
            channel.id,
            channel.epoch,
            Buffer.from(channel.key, "hex"),
            "invite",
            channel.name,
          );
        }
      }
      if (!existing.joinPublished) {
        await this.publishJoin(bundle);
        existing.joinPublished = true;
      }
      await this.store?.saveCommunity({
        bundle: existing.bundle,
        joinPublished: existing.joinPublished,
      });
      this.rememberInvite(rumor.id);
      return;
    }
    if (this.communities.size >= MAX_COMMUNITIES) return;
    if (
      this.channelSubscriptionCount() + bundle.channels.length >
      MAX_CONCORD_CHANNEL_SUBSCRIPTIONS
    ) {
      return;
    }

    await this.relayTransport.addRelays(bundle.relays);
    console.log(`[Concord] Community relay registration completed for ${bundle.relays.length} relay(s)`);
    if (!this.accepting) return;
    const state = this.registerCommunityState(bundle, false);
    await this.store?.saveCommunity({
      bundle: state.bundle,
      joinPublished: false,
    });
    console.log(`[Concord] Publishing Kind 3306 Join for community ${bundle.community_id.slice(0, 8)}...`);
    await this.publishJoin(bundle);
    state.joinPublished = true;
    await this.store?.saveCommunity({
      bundle: state.bundle,
      joinPublished: true,
    });
    this.rememberInvite(rumor.id);
  }

  private registerCommunityState(
    bundle: ConcordInviteBundle,
    joinPublished: boolean,
  ): CommunityState {
    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(bundle.community_root, "hex"),
      Buffer.from(bundle.community_id, "hex"),
      bundle.root_epoch,
    );
    const controlReadGroup: ConcordGroupKey = {
      ...controlRead,
      publicKey: bundle.control_pk,
    };
    const guestbookGroup = deriveConcordGroupKey(
      "concord/guestbook",
      Buffer.from(bundle.community_root, "hex"),
      Buffer.from(bundle.community_id, "hex"),
      bundle.root_epoch,
    );
    const state = {} as CommunityState;
    state.bundle = bundle;
    state.controlReadGroup = controlReadGroup;
    state.guestbookGroup = guestbookGroup;
    state.controlEditions = [];
    state.control = emptyControl(bundle);
    state.channels = new Map();
    state.joinPublished = joinPublished;
    state.controlDispose = this.relayTransport.registerSubscription(
      {
        kinds: [CONCORD_STREAM_KIND, CONCORD_EPHEMERAL_STREAM_KIND],
        authors: [bundle.control_pk],
      },
      (event) => this.handleControlEvent(state, event),
    );
    state.guestbookDispose = this.relayTransport.registerSubscription(
      {
        kinds: [CONCORD_STREAM_KIND, CONCORD_EPHEMERAL_STREAM_KIND],
        authors: [guestbookGroup.publicKey],
      },
      (event) => this.handleGuestbookEvent(state, event),
    );
    this.communities.set(bundle.community_id, state);
    for (const channel of bundle.channels) {
      this.subscribeChannel(
        state,
        channel.id,
        channel.epoch,
        Buffer.from(channel.key, "hex"),
        "invite",
        channel.name,
      );
    }
    return state;
  }

  private async publishJoin(bundle: ConcordInviteBundle): Promise<void> {
    const guestbook = deriveConcordGroupKey(
      "concord/guestbook",
      Buffer.from(bundle.community_root, "hex"),
      Buffer.from(bundle.community_id, "hex"),
      bundle.root_epoch,
    );
    const now = this.now();
    const tags: string[][] = [["ms", String(now % 1_000)]];
    if (bundle.creator_npub) {
      tags.push(["invite", bundle.creator_npub, bundle.label ?? ""]);
    }
    const join = createConcordStreamEvent(this.secretKey, guestbook, {
      kind: CONCORD_JOIN_KIND,
      content: "join",
      tags,
      created_at: Math.floor(now / 1_000),
    });
    await this.relayTransport.publishToRelays(join, bundle.relays);
  }

  public async publishChannelMessage(
    communityId: string,
    channelId: string,
    message: string,
    extraTags: string[][] = [],
  ): Promise<void> {
    if (!this.accepting) {
      throw new Error("Concord community manager is stopped");
    }
    let state: CommunityState | undefined;
    if (this.communities.has(communityId)) {
      state = this.communities.get(communityId);
    } else if (
      (communityId === "default" || communityId === "*") &&
      this.communities.size === 1
    ) {
      state = [...this.communities.values()][0];
    }
    if (!state) {
      throw new Error("Concord community is not active");
    }

    const activeChannels = [...state.channels.values()].filter((ch) => ch.active);
    let targetChannel = activeChannels.find((ch) => ch.channelId === channelId);
    if (!targetChannel) {
      if (channelId === "default") {
        targetChannel = this.resolveDefaultChannel(state)?.context;
      } else {
        targetChannel = activeChannels.find(
          (ch) =>
            this.getChannelName(state, ch.channelId)?.toLowerCase() ===
            channelId.toLowerCase(),
        );
        if (!targetChannel && channelId.toLowerCase() === "general") {
          targetChannel = this.resolveDefaultChannel(state)?.context;
        }
      }
    }
    if (!targetChannel) {
      throw new Error("Concord channel is not active");
    }

    await this.publishChannelRumor(state, targetChannel, {
      kind: 9,
      content: message,
      tags: extraTags,
    });
  }

  public stop(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const state of this.communities.values()) {
      state.controlDispose();
      state.guestbookDispose();
      for (const channel of state.channels.values()) channel.dispose();
    }
    this.communities.clear();
    this.processedWraps.clear();
    this.processedRumors.clear();
    this.acceptedInvites.clear();
  }

  private rememberWrap(eventId: string): boolean {
    if (this.processedWraps.has(eventId)) return false;
    if (this.processedWraps.size >= MAX_PROCESSED_WRAPS) {
      const oldest = this.processedWraps.values().next().value;
      if (oldest) this.processedWraps.delete(oldest);
    }
    this.processedWraps.add(eventId);
    return true;
  }

  private rememberRumor(rumorId: string): boolean {
    if (this.processedRumors.has(rumorId)) return false;
    if (this.processedRumors.size >= MAX_PROCESSED_RUMORS) {
      const oldest = this.processedRumors.values().next().value;
      if (oldest) this.processedRumors.delete(oldest);
    }
    this.processedRumors.add(rumorId);
    return true;
  }

  private async claimRumor(rumorId: string): Promise<boolean> {
    if (!this.rememberRumor(rumorId)) return false;
    try {
      return await this.persistEventAcceptance(rumorId);
    } catch {
      return false;
    }
  }

  private rememberInvite(rumorId: string): void {
    if (this.acceptedInvites.size >= MAX_ACCEPTED_INVITES) {
      const oldest = this.acceptedInvites.values().next().value;
      if (oldest) this.acceptedInvites.delete(oldest);
    }
    this.acceptedInvites.add(rumorId);
  }

  private subscribeChannel(
    state: CommunityState,
    channelId: string,
    epoch: number,
    channelSecret: Uint8Array,
    source: ChannelContext["source"],
    name?: string,
  ): void {
    if (this.channelSubscriptionCount() >= MAX_CONCORD_CHANNEL_SUBSCRIPTIONS) return;
    const group = deriveConcordGroupKey(
      "concord/channel",
      channelSecret,
      Buffer.from(channelId, "hex"),
      epoch,
    );
    if (state.channels.has(group.publicKey)) return;
    const context = {} as ChannelContext;
    context.channelId = channelId;
    context.epoch = epoch;
    context.group = group;
    context.source = source;
    context.name = name;
    context.active = true;
    const relayDispose = this.relayTransport.registerSubscription(
      {
        kinds: [CONCORD_STREAM_KIND, CONCORD_EPHEMERAL_STREAM_KIND],
        authors: [group.publicKey],
      },
      (event) => this.handleChannelEvent(state, context, event),
    );
    context.dispose = () => {
      if (!context.active) return;
      context.active = false;
      relayDispose();
    };
    state.channels.set(group.publicKey, context);
    console.log(`[Concord] Subscribed to ${source} channel ${channelId.slice(0, 8)}... (epoch ${epoch}) with stream pk ${group.publicKey.slice(0, 8)}...`);
  }

  private channelSubscriptionCount(): number {
    let count = 0;
    for (const state of this.communities.values()) count += state.channels.size;
    return count;
  }

  private getChannelName(state: CommunityState, channelId: string): string | undefined {
    const fromControl = state.control.channels.find(
      (channel) => channel.channelId === channelId && !channel.deleted,
    )?.name;
    if (fromControl) return fromControl;
    const fromInvite = state.bundle.channels.find((channel) => channel.id === channelId)?.name;
    if (fromInvite) return fromInvite;
    for (const context of state.channels.values()) {
      if (context.channelId === channelId && context.name) {
        return context.name;
      }
    }
    return undefined;
  }

  private resolveDefaultChannel(
    state: CommunityState,
  ): { context: ChannelContext; name?: string } | undefined {
    const activeChannels = [...state.channels.values()].filter((ch) => ch.active);
    if (activeChannels.length === 0) return undefined;

    if (this.defaultChannelId) {
      const configured = activeChannels.find((ch) => {
        const name = this.getChannelName(state, ch.channelId);
        return (
          ch.channelId === this.defaultChannelId ||
          name?.toLowerCase() === this.defaultChannelId?.toLowerCase()
        );
      });
      if (configured) {
        return {
          context: configured,
          name: this.getChannelName(state, configured.channelId),
        };
      }
    }

    const general = activeChannels.find(
      (ch) => this.getChannelName(state, ch.channelId)?.toLowerCase() === "general",
    );
    if (general) {
      return {
        context: general,
        name: this.getChannelName(state, general.channelId),
      };
    }

    const first = activeChannels[0];
    return {
      context: first,
      name: this.getChannelName(state, first.channelId),
    };
  }

  private async handleControlEvent(state: CommunityState, event: NostrEvent): Promise<void> {
    if (!this.accepting) return;
    const decoded = decodeConcordStreamEvent(event, state.controlReadGroup, {
      allowedKinds: [CONCORD_CONTROL_KIND],
      sealKind: 20014,
    });
    if (!decoded || !this.rememberWrap(event.id)) return;
    const edition = parseControlEdition(decoded.rumor);
    if (!edition) return;
    if (state.controlEditions.length >= MAX_CONTROL_EDITIONS) state.controlEditions.shift();
    state.controlEditions.push(edition);
    state.control = foldConcordControl(state.controlEditions, {
      communityId: state.bundle.community_id,
      owner: state.bundle.owner,
    });
    const definitions = new Map(
      state.control.channels.map((channel) => [channel.channelId, channel]),
    );
    for (const [publicKey, context] of state.channels) {
      const definition = definitions.get(context.channelId);
      if (
        definition &&
        (definition.deleted ||
          (definition.private && context.source === "public") ||
          (!definition.private && context.source === "invite"))
      ) {
        context.dispose();
        state.channels.delete(publicKey);
      }
    }
    const activeChannelIds = new Set(
      [...state.channels.values()].map((context) => context.channelId),
    );
    for (const channel of state.control.channels) {
      if (channel.deleted) continue;
      if (activeChannelIds.has(channel.channelId) || channel.private) continue;
      this.subscribeChannel(
        state,
        channel.channelId,
        state.bundle.root_epoch,
        Buffer.from(state.bundle.community_root, "hex"),
        "public",
        channel.name,
      );
      activeChannelIds.add(channel.channelId);
    }
  }

  private async handleGuestbookEvent(state: CommunityState, event: NostrEvent): Promise<void> {
    if (!this.accepting) return;
    const decoded = decodeConcordStreamEvent(event, state.guestbookGroup, {
      allowedKinds: [CONCORD_JOIN_KIND],
    });
    if (!decoded || !this.rememberWrap(event.id)) return;
    if (decoded.author === this.pubkey) return;
    if (!this.isFreshEvent(decoded.rumor.created_at)) return;
    const handler = this.onMemberJoinHandler;
    if (!handler) return;
    if (!(await this.claimRumor(decoded.rumor.id)) || !this.accepting) return;

    const resolvedChannel = this.resolveDefaultChannel(state);
    await handler({
      communityId: state.bundle.community_id,
      communityName: state.bundle.name,
      memberPubkey: decoded.author,
      memberNpub: nip19.npubEncode(decoded.author),
      eventId: decoded.rumor.id,
      createdAt: decoded.rumor.created_at,
      ...(resolvedChannel ? { defaultChannelId: resolvedChannel.context.channelId } : {}),
      ...(resolvedChannel?.name ? { defaultChannelName: resolvedChannel.name } : {}),
      replyChannel: async (message: string, extraTags: string[][] = []) => {
        const target = this.resolveDefaultChannel(state);
        if (!target) {
          throw new Error("No active Concord channel available for welcome message");
        }
        const tags = extraTags.map((tag) => [...tag]);
        if (!tags.some((tag) => tag[0] === "p" && tag[1] === decoded.author)) {
          tags.push(["p", decoded.author]);
        }
        await this.publishChannelRumor(state, target.context, {
          kind: 9,
          content: message,
          tags,
        });
      },
      sendDirectMessage: async (message: string) => {
        if (!this.sendDirectMessage) {
          throw new Error("Nostr direct message sender is not configured");
        }
        await this.sendDirectMessage(decoded.author, message);
      },
    });
  }

  private isBotMentioned(rumor: ConcordRumor): boolean {
    const lowerContent = rumor.content.toLowerCase();
    if (
      lowerContent.includes(this.pubkey.toLowerCase()) ||
      lowerContent.includes(this.npub.toLowerCase()) ||
      lowerContent.includes("@tunnelsats")
    ) {
      return true;
    }
    const hasBotPTag = rumor.tags.some(
      (tag) => tag[0] === "p" && tag[1] === this.pubkey,
    );
    const hasETag = rumor.tags.some((tag) => tag[0] === "e");
    return hasBotPTag && !hasETag;
  }

  private async handleChannelEvent(
    state: CommunityState,
    channel: ChannelContext,
    event: NostrEvent,
  ): Promise<void> {
    if (!this.accepting || !channel.active) return;
    console.log(`[Concord] Received stream wrap ${event.id.slice(0, 8)}... in channel ${channel.channelId.slice(0, 8)}...`);
    const decoded = decodeConcordStreamEvent(event, channel.group, {
      allowedKinds: [9],
      channelId: channel.channelId,
      epoch: channel.epoch,
    });
    if (!decoded || !this.rememberWrap(event.id)) return;
    if (decoded.author === this.pubkey) return;
    if (!this.isFreshEvent(decoded.rumor.created_at)) return;
    console.log(`[Concord] Decrypted Kind 9 message ${decoded.rumor.id.slice(0, 8)}... from ${decoded.author.slice(0, 8)}... in channel ${channel.channelId.slice(0, 8)}...`);

    if (hasWireGuardLeak(decoded.rumor.content)) {
      if (state.control.canManageMessages(this.pubkey, decoded.author, channel.channelId)) {
        await this.publishChannelRumor(state, channel, {
          kind: 5,
          content: "",
          tags: [
            ["e", decoded.rumor.id],
            ["p", decoded.author],
            ["k", "9"],
          ],
        });
        await this.publishChannelRumor(state, channel, {
          kind: 9,
          content: CONCORD_PRIVACY_ADVISORY,
          tags: [
            ["e", decoded.rumor.id],
            ["p", decoded.author],
            ["k", "9"],
          ],
        });
      }
      return;
    }

    const channelName = this.getChannelName(state, channel.channelId);
    const isModerator = state.control.canManageChannelOrMessages(
      decoded.author,
      channel.channelId,
    );

    const command = parseCommand(decoded.rumor.content);
    if (command) {
      if (!this.isCommandAllowedInChannel(command.command)) {
        console.log(`[Concord] Ignoring non-public command in channel ${channel.channelId.slice(0, 8)}...`);
        return;
      }
      if (!(await this.claimRumor(decoded.rumor.id)) || !this.accepting) return;

      console.log(`[Concord] Dispatching channel command /${command.command} from ${decoded.author.slice(0, 8)}... in channel ${channel.channelId.slice(0, 8)}...`);
      await this.processMessage(
        decoded.rumor.content,
        decoded.author,
        decoded.rumor.id,
        (message) =>
          this.publishChannelRumor(state, channel, {
            kind: 9,
            content: message,
            tags: [
              ["e", decoded.rumor.id],
              ["p", decoded.author],
              ["k", "9"],
            ],
          }),
        {
          transport: "concord-channel",
          communityId: state.bundle.community_id,
          channelId: channel.channelId,
          ...(channelName ? { channelName } : {}),
          isModerator,
        },
      );
      return;
    }

    const mentionHandler = this.onChannelMentionHandler;
    if (!mentionHandler || !this.isBotMentioned(decoded.rumor)) {
      return;
    }
    if (!(await this.claimRumor(decoded.rumor.id)) || !this.accepting) return;

    await mentionHandler({
      communityId: state.bundle.community_id,
      channelId: channel.channelId,
      ...(channelName ? { channelName } : {}),
      senderPubkey: decoded.author,
      senderNpub: nip19.npubEncode(decoded.author),
      eventId: decoded.rumor.id,
      content: decoded.rumor.content,
      isModerator,
      reply: (message: string, extraTags: string[][] = []) =>
        this.publishChannelRumor(state, channel, {
          kind: 9,
          content: message,
          tags: [
            ["e", decoded.rumor.id],
            ["p", decoded.author],
            ["k", "9"],
            ...extraTags.map((tag) => [...tag]),
          ],
        }),
    });
  }

  private async publishChannelRumor(
    state: CommunityState,
    channel: ChannelContext,
    rumor: { kind: number; content: string; tags: string[][] },
  ): Promise<void> {
    if (!this.accepting) throw new Error("Concord community manager is stopped");
    const now = this.now();
    const event = createConcordStreamEvent(this.secretKey, channel.group, {
      kind: rumor.kind,
      content: rumor.content,
      tags: [
        ["channel", channel.channelId],
        ["epoch", String(channel.epoch)],
        ["ms", String(now % 1_000)],
        ...rumor.tags,
      ],
      created_at: Math.floor(now / 1_000),
    });
    await this.relayTransport.publishToRelays(event, state.bundle.relays);
    console.log(`[Concord] Published Kind ${rumor.kind} reply to channel ${channel.channelId.slice(0, 8)}...`);
  }
}
