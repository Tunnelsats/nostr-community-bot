export interface NostrBotConfig {
  /** Bot secret key in nsec format (nsec1...) or 64-char hex format */
  nsec: string;
  /** List of Nostr WebSocket relay URLs */
  relays: string[];
  /** Optional public key hex (derived automatically if not provided) */
  pubkey?: string;
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
