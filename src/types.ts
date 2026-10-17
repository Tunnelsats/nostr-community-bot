import type {
  ConcordChannelDefinition,
  ConcordControlEdition,
  ConcordGroupKey,
  ConcordInviteBundle,
  ConcordInviteChannel,
  ConcordRoleType,
  ConcordRumor,
  DecodedConcordEvent,
  FoldedConcordControl,
} from "./concord.js";

export type {
  ConcordChannelDefinition,
  ConcordControlEdition,
  ConcordGroupKey,
  ConcordInviteBundle,
  ConcordInviteChannel,
  ConcordRoleType,
  ConcordRumor,
  DecodedConcordEvent,
  FoldedConcordControl,
};

export interface ProcessedEventStore {
  /** Return whether an authenticated inner rumor was already accepted by this bot. */
  isProcessed(eventId: string): boolean | Promise<boolean>;
  /**
   * Persist acceptance before command side effects are dispatched. Implementations should
   * atomically claim the ID and return false when another process already claimed it.
   */
  markProcessed(eventId: string): boolean | void | Promise<boolean | void>;
}

export interface DirectMessageReplayConfig {
  /** Maximum age of an authenticated inner rumor. Defaults to 300 seconds. */
  offlineGraceSeconds?: number;
  /** Optional durable rumor ledger used across process restarts. */
  store?: ProcessedEventStore;
}

export interface PersistedConcordCommunity {
  bundle: ConcordInviteBundle;
  joinPublished: boolean;
}

export interface ConcordCommunityStore {
  loadCommunities(): PersistedConcordCommunity[] | Promise<PersistedConcordCommunity[]>;
  saveCommunity(community: PersistedConcordCommunity): void | Promise<void>;
}

export interface ConcordMemberJoinContext {
  communityId: string;
  communityName: string;
  memberPubkey: string;
  memberNpub: string;
  eventId: string;
  createdAt: number;
  defaultChannelId?: string;
  defaultChannelName?: string;
  replyChannel: (message: string, extraTags?: string[][]) => Promise<void>;
  sendDirectMessage: (message: string) => Promise<void>;
}

export type ConcordMemberJoinHandler = (
  ctx: ConcordMemberJoinContext,
) => Promise<void> | void;

export interface ConcordChannelMentionContext {
  communityId: string;
  channelId: string;
  channelName?: string;
  senderPubkey: string;
  senderNpub: string;
  eventId: string;
  content: string;
  isModerator: boolean;
  senderRole?: ConcordRoleType;
  reply: (message: string, extraTags?: string[][]) => Promise<void>;
}

export type ConcordChannelMentionHandler = (
  ctx: ConcordChannelMentionContext,
) => Promise<void> | void;

export interface ConcordConfig {
  enabled: boolean;
  store?: ConcordCommunityStore;
  defaultChannelId?: string;
  channelReadyTimeoutMs?: number;
  onMemberJoin?: ConcordMemberJoinHandler;
  onChannelMention?: ConcordChannelMentionHandler;
}

export type BotCommandArgType = "string" | "int" | "number" | "bool" | "user" | "choice";

export interface BotCommandArgSpec {
  name: string;
  type: BotCommandArgType;
  description?: string;
  required?: boolean;
  choices?: string[];
}

export interface BotCommandManifestArg {
  name: string;
  type: BotCommandArgType;
  description: string;
  required: boolean;
  choices: string[];
}

export interface BotCommandManifestEntry {
  name: string;
  description: string;
  args: BotCommandManifestArg[];
}

export interface BotCommandManifest {
  v: 1;
  commands: BotCommandManifestEntry[];
}

export interface BotManifestConfig {
  enabled: boolean;
  /** When true (default when enabled), non-destructively ensures `"bot": true` (NIP-24) on existing Kind 0 profile metadata. */
  publishBotProfileFlag?: boolean;
  /**
   * Additional discovery relays (such as Armada's DISCOVERY_RELAYS:
   * wss://purplepag.es, wss://relay.nostr.band, wss://nos.lol) to publish
   * replaceable Kind 10304 command manifests and Kind 0 bot profile updates to,
   * alongside connected bot relays. Defaults to DEFAULT_BOT_DISCOVERY_RELAYS
   * when botManifest is enabled. Pass `[]` to disable external discovery relay publication.
   */
  discoveryRelays?: string[];
}

export interface CommandRegistrationOptions {
  allowInChannel?: boolean;
  /** Short description (<= 200 UTF-8 bytes) published in Kind 10304 Bot Command Manifest */
  description?: string;
  /** Typed arguments published in Kind 10304 Bot Command Manifest */
  args?: BotCommandArgSpec[];
  /** Set false to exclude from Kind 10304 Bot Command Manifest (defaults to true when description is provided) */
  includeInManifest?: boolean;
}

export interface NostrBotConfig {
  /** Bot secret key in nsec format (nsec1...) or 64-char hex format */
  nsec: string;
  /** List of Nostr WebSocket relay URLs */
  relays: string[];
  /** Optional public key hex (derived automatically if not provided) */
  pubkey?: string;
  /** Optional hostname resolver for validating untrusted recipient DM relays. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Bounds historical DM intake and optionally persists processed inner rumors. */
  directMessageReplay?: DirectMessageReplayConfig;
  /** Explicit opt-in for bounded Concord V2 direct-invite and community handling. */
  concord?: ConcordConfig;
  /** Explicit opt-in for publishing NIP-24 bot profile flag and Kind 10304 Bot Command Manifest. */
  botManifest?: BotManifestConfig;
}

export type RelayConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface RelayConnectionStatus {
  url: string;
  state: RelayConnectionState;
  reconnectAttempts: number;
}

export interface CommandContext {
  /** Command name executed (without leading slash) */
  command: string;
  /** Command arguments array */
  args: string[];
  /** Raw command message text preserving original newlines and whitespace */
  rawText?: string;
  /** Sender public key in hex format */
  senderPubkey: string;
  /** Event ID of the triggering message */
  eventId: string;
  /** Send an encrypted response back to the user */
  reply: (message: string) => Promise<void>;
  transport?: "dm" | "concord-channel";
  communityId?: string;
  channelId?: string;
  channelName?: string;
  isModerator?: boolean;
  senderRole?: ConcordRoleType;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void> | void;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}
