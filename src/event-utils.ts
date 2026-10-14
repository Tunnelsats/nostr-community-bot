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
 * Supports unquoted tokens and Armada BotCommandComposer shell-quoted spans ("..." with \" and \\ escaping).
 * Example: "/ping 03864e..." -> { command: "ping", args: ["03864e..."] }
 */
export function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const body = trimmed.slice(1);
  if (!body || body.startsWith('"') || /^\s/.test(body)) {
    return null;
  }

  const firstSpaceMatch = body.match(/\s/);
  const commandRaw = firstSpaceMatch ? body.slice(0, firstSpaceMatch.index) : body;
  const command = commandRaw.toLowerCase();
  if (!command) {
    return null;
  }

  const rest = firstSpaceMatch ? body.slice((firstSpaceMatch.index ?? 0) + 1) : "";
  const args: string[] = [];
  let i = 0;

  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i])) {
      i++;
    }
    if (i >= rest.length) {
      break;
    }

    if (rest[i] === '"') {
      let cursor = i + 1;
      let value = "";
      let closed = false;
      while (cursor < rest.length) {
        if (
          rest[cursor] === "\\" &&
          cursor + 1 < rest.length &&
          (rest[cursor + 1] === '"' || rest[cursor + 1] === "\\")
        ) {
          value += rest[cursor + 1];
          cursor += 2;
        } else if (rest[cursor] === '"') {
          closed = true;
          cursor++;
          break;
        } else {
          value += rest[cursor];
          cursor++;
        }
      }

      if (closed && (cursor >= rest.length || /\s/.test(rest[cursor]))) {
        args.push(value);
        i = cursor;
        continue;
      }
    }

    const start = i;
    while (i < rest.length && !/\s/.test(rest[i])) {
      i++;
    }
    args.push(rest.slice(start, i));
  }

  return { command, args };
}
