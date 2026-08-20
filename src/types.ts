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

export interface NostrBotConfig {
  /** Bot secret key in nsec format (nsec1...) or 64-char hex format */
  nsec: string;
  /** List of Nostr WebSocket relay URLs */
  relays: string[];
  /** Optional public key hex (derived automatically if not provided) */
  pubkey?: string;
  /** Bounds historical DM intake and optionally persists processed inner rumors. */
  directMessageReplay?: DirectMessageReplayConfig;
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
  /** Sender public key in hex format */
  senderPubkey: string;
  /** Event ID of the triggering message */
  eventId: string;
  /** Send an encrypted response back to the user */
  reply: (message: string) => Promise<void>;
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
