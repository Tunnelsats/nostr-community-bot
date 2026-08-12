import { getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { NostrBotConfig, CommandHandler, CommandContext } from "./types.js";
import { parseSecretKey, parseCommand } from "./event-utils.js";

export class NostrCommunityBot {
  private secretKey: Uint8Array;
  private pubkeyHex: string;
  private relays: string[];
  private commands: Map<string, CommandHandler> = new Map();

  constructor(config: NostrBotConfig) {
    if (!config.nsec) {
      throw new Error("NostrBotConfig error: 'nsec' secret key is required.");
    }
    if (!config.relays || config.relays.length === 0) {
      throw new Error("NostrBotConfig error: at least one relay URL is required.");
    }

    this.secretKey = parseSecretKey(config.nsec);
    this.pubkeyHex = getPublicKey(this.secretKey);
    this.relays = config.relays;
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
    // Connect to Nostr relays and subscribe to incoming NIP-17 / NIP-59 / Concord events
    // This will be expanded as relay connection handlers are wired in production
  }
}
