import { nip17, nip44 } from "nostr-tools";
import { getEventHash, verifyEvent, type NostrEvent, type UnsignedEvent } from "nostr-tools/pure";

export const MAX_ENCRYPTED_CONTENT_LENGTH = 256 * 1024;

const INVALID_DIRECT_MESSAGE = "Invalid NIP-17 direct message";
const INVALID_REPLY = "Invalid NIP-17 reply";
const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const HEX_64_BYTES = /^[0-9a-f]{128}$/;

export interface DirectMessageRumor extends UnsignedEvent {
  id: string;
  kind: 14;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTags(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
  );
}

function isNostrEvent(value: unknown): value is NostrEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    Number.isInteger(value.kind) &&
    Number.isInteger(value.created_at) &&
    typeof value.content === "string" &&
    isTags(value.tags) &&
    typeof value.pubkey === "string" &&
    HEX_32_BYTES.test(value.pubkey) &&
    typeof value.id === "string" &&
    HEX_32_BYTES.test(value.id) &&
    typeof value.sig === "string" &&
    HEX_64_BYTES.test(value.sig)
  );
}

function verifySignedEvent(event: NostrEvent): boolean {
  return verifyEvent({
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    created_at: event.created_at,
    pubkey: event.pubkey,
    id: event.id,
    sig: event.sig,
  });
}

function isRumor(value: unknown): value is DirectMessageRumor {
  if (!isRecord(value) || Object.hasOwn(value, "sig")) {
    return false;
  }

  return (
    value.kind === 14 &&
    Number.isInteger(value.created_at) &&
    typeof value.content === "string" &&
    isTags(value.tags) &&
    typeof value.pubkey === "string" &&
    HEX_32_BYTES.test(value.pubkey) &&
    typeof value.id === "string" &&
    HEX_32_BYTES.test(value.id)
  );
}

function hasSingleRecipient(tags: string[][], recipientPubkey: string): boolean {
  const recipientTags = tags.filter((tag) => tag[0] === "p");
  return recipientTags.length === 1 && recipientTags[0][1] === recipientPubkey;
}

function decryptJson(
  ciphertext: string,
  recipientSecretKey: Uint8Array,
  senderPubkey: string,
): unknown {
  if (ciphertext.length > MAX_ENCRYPTED_CONTENT_LENGTH) {
    throw new Error(INVALID_DIRECT_MESSAGE);
  }

  const conversationKey = nip44.v2.utils.getConversationKey(recipientSecretKey, senderPubkey);
  const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);
  return JSON.parse(plaintext) as unknown;
}

export function unwrapDirectMessage(
  wrap: NostrEvent,
  recipientSecretKey: Uint8Array,
  recipientPubkey: string,
): DirectMessageRumor {
  try {
    if (
      recipientSecretKey.length !== 32 ||
      !HEX_32_BYTES.test(recipientPubkey) ||
      !isNostrEvent(wrap) ||
      wrap.kind !== 1059 ||
      wrap.content.length > MAX_ENCRYPTED_CONTENT_LENGTH ||
      !hasSingleRecipient(wrap.tags, recipientPubkey) ||
      !verifySignedEvent(wrap)
    ) {
      throw new Error(INVALID_DIRECT_MESSAGE);
    }

    const sealValue = decryptJson(wrap.content, recipientSecretKey, wrap.pubkey);
    if (
      !isNostrEvent(sealValue) ||
      sealValue.kind !== 13 ||
      sealValue.tags.length !== 0 ||
      !verifySignedEvent(sealValue)
    ) {
      throw new Error(INVALID_DIRECT_MESSAGE);
    }

    const rumorValue = decryptJson(sealValue.content, recipientSecretKey, sealValue.pubkey);
    if (
      !isRumor(rumorValue) ||
      rumorValue.pubkey !== sealValue.pubkey ||
      !hasSingleRecipient(rumorValue.tags, recipientPubkey) ||
      rumorValue.id !== getEventHash(rumorValue)
    ) {
      throw new Error(INVALID_DIRECT_MESSAGE);
    }

    return {
      id: rumorValue.id,
      pubkey: rumorValue.pubkey,
      created_at: rumorValue.created_at,
      kind: 14,
      tags: rumorValue.tags.map((tag) => [...tag]),
      content: rumorValue.content,
    };
  } catch {
    throw new Error(INVALID_DIRECT_MESSAGE);
  }
}

export function createDirectMessageReply(
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  message: string,
  replyToEventId: string,
): NostrEvent {
  try {
    if (
      senderSecretKey.length !== 32 ||
      !HEX_32_BYTES.test(recipientPubkey) ||
      typeof message !== "string" ||
      !HEX_32_BYTES.test(replyToEventId)
    ) {
      throw new Error(INVALID_REPLY);
    }

    return nip17.wrapEvent(senderSecretKey, { publicKey: recipientPubkey }, message, undefined, {
      eventId: replyToEventId,
    });
  } catch {
    throw new Error(INVALID_REPLY);
  }
}
