import { nip19 } from "nostr-tools";

/**
 * Normalizes a Nostr private key input (nsec string or hex) into a Uint8Array secret key bytes.
 */
export function parseSecretKey(nsecOrHex: string): Uint8Array {
  const trimmed = nsecOrHex.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "nsec") {
      return decoded.data;
    }
    throw new Error(`Invalid nsec key type: ${decoded.type}`);
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Uint8Array.from(Buffer.from(trimmed, "hex"));
  }

  throw new Error("Invalid Nostr private key format. Expected nsec1... or 64-char hex string.");
}

/**
 * Parses raw text input into a command name and arguments array.
 * Example: "/ping 03864e..." -> { command: "ping", args: ["03864e..."] }
 */
export function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (!command) {
    return null;
  }

  return { command, args };
}
