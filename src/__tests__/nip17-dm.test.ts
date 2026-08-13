import { describe, expect, it } from "vitest";
import { nip44 } from "nostr-tools";
import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  type NostrEvent,
  type UnsignedEvent,
} from "nostr-tools/pure";
import {
  createDirectMessageReply,
  MAX_ENCRYPTED_CONTENT_LENGTH,
  unwrapDirectMessage,
} from "../nip17-dm.js";

const BOT_SECRET = Uint8Array.from(
  Buffer.from("a3c06ceaab7c2c3dfe3f0d8f6c36dbd1fe7bca59af71a78f9b24a23acf244d8e", "hex"),
);
const SENDER_SECRET = Uint8Array.from(
  Buffer.from("0beebd062ec8735f4243466049d7747ef5d6594ee838de147f8aab842b15e273", "hex"),
);
const OTHER_SECRET = Uint8Array.from(
  Buffer.from("e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45", "hex"),
);
const WRAPPER_SECRET = Uint8Array.from(
  Buffer.from("4f02eac59266002db5801adc5270700ca69d5b8f761d8732fab2fbf233c90cbd", "hex"),
);

const BOT_PUBKEY = getPublicKey(BOT_SECRET);
const SENDER_PUBKEY = getPublicKey(SENDER_SECRET);
const OTHER_PUBKEY = getPublicKey(OTHER_SECRET);

interface BuildOptions {
  rumor?: Partial<UnsignedEvent> & { id?: string; sig?: string };
  seal?: Partial<NostrEvent>;
  wrap?: Partial<NostrEvent>;
  sealPlaintext?: string;
  rumorPlaintext?: string;
}

function encrypt(plaintext: string, privateKey: Uint8Array, publicKey: string): string {
  const conversationKey = nip44.v2.utils.getConversationKey(privateKey, publicKey);
  return nip44.v2.encrypt(plaintext, conversationKey, new Uint8Array(32).fill(7));
}

function createRumor(overrides: BuildOptions["rumor"] = {}): UnsignedEvent & { id: string } {
  const rumor: UnsignedEvent & { id: string; sig?: string } = {
    pubkey: SENDER_PUBKEY,
    created_at: 1_700_000_000,
    kind: 14,
    tags: [["p", BOT_PUBKEY]],
    content: "/ping node-id",
    id: "",
    ...overrides,
  };
  if (!overrides.id) {
    rumor.id = getEventHash(rumor);
  }
  return rumor;
}

function buildGiftWrap(options: BuildOptions = {}): NostrEvent {
  const rumor = createRumor(options.rumor);
  const rumorPlaintext = options.rumorPlaintext ?? JSON.stringify(rumor);
  const seal = finalizeEvent(
    {
      kind: options.seal?.kind ?? 13,
      created_at: options.seal?.created_at ?? 1_699_999_000,
      tags: options.seal?.tags ?? [],
      content: options.seal?.content ?? encrypt(rumorPlaintext, SENDER_SECRET, BOT_PUBKEY),
    },
    SENDER_SECRET,
  );
  const customizedSeal: NostrEvent = { ...seal, ...options.seal };
  const sealPlaintext = options.sealPlaintext ?? JSON.stringify(customizedSeal);

  return finalizeEvent(
    {
      kind: options.wrap?.kind ?? 1059,
      created_at: options.wrap?.created_at ?? 1_699_998_000,
      tags: options.wrap?.tags ?? [["p", BOT_PUBKEY]],
      content: options.wrap?.content ?? encrypt(sealPlaintext, WRAPPER_SECRET, BOT_PUBKEY),
    },
    WRAPPER_SECRET,
  );
}

function corruptSignature(signature: string): string {
  const lastCharacter = signature.at(-1);
  return `${signature.slice(0, -1)}${lastCharacter === "0" ? "1" : "0"}`;
}

describe("unwrapDirectMessage", () => {
  it("unwraps a valid gift wrap and authenticates the inner sender", () => {
    const wrap = buildGiftWrap();

    const rumor = unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY);

    expect(rumor).toEqual({
      id: getEventHash({
        pubkey: SENDER_PUBKEY,
        created_at: 1_700_000_000,
        kind: 14,
        tags: [["p", BOT_PUBKEY]],
        content: "/ping node-id",
      }),
      pubkey: SENDER_PUBKEY,
      created_at: 1_700_000_000,
      kind: 14,
      tags: [["p", BOT_PUBKEY]],
      content: "/ping node-id",
    });
    expect(rumor.pubkey).not.toBe(wrap.pubkey);
  });

  it.each([
    ["wrong kind", buildGiftWrap({ wrap: { kind: 1058 } })],
    ["wrong recipient", buildGiftWrap({ wrap: { tags: [["p", OTHER_PUBKEY]] } })],
    [
      "multiple recipients",
      buildGiftWrap({
        wrap: {
          tags: [
            ["p", BOT_PUBKEY],
            ["p", OTHER_PUBKEY],
          ],
        },
      }),
    ],
  ])("rejects an outer wrapper with %s", (_description, wrap) => {
    expect(() => unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY)).toThrow(
      "Invalid NIP-17 direct message",
    );
  });

  it("rejects an invalid outer event signature", () => {
    const wrap = buildGiftWrap();
    const invalid = { ...wrap, sig: corruptSignature(wrap.sig) };

    expect(() => unwrapDirectMessage(invalid, BOT_SECRET, BOT_PUBKEY)).toThrow(
      "Invalid NIP-17 direct message",
    );
  });

  it("rejects malformed and oversized wrapper ciphertext without leaking its contents", () => {
    const malformed = buildGiftWrap({ wrap: { content: "not-ciphertext" } });
    const oversizedContent = "sensitive-oversized-content".padEnd(
      MAX_ENCRYPTED_CONTENT_LENGTH + 1,
      "x",
    );
    const oversized = buildGiftWrap({ wrap: { content: oversizedContent } });

    for (const wrap of [malformed, oversized]) {
      let error: unknown;
      try {
        unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Invalid NIP-17 direct message");
      expect((error as Error).message).not.toContain("sensitive");
    }
  });

  it("rejects malformed decrypted seal JSON", () => {
    const wrap = buildGiftWrap({ sealPlaintext: "not-json" });

    expect(() => unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY)).toThrow(
      "Invalid NIP-17 direct message",
    );
  });

  it.each([
    ["wrong kind", buildGiftWrap({ seal: { kind: 12 } })],
    ["non-empty tags", buildGiftWrap({ seal: { tags: [["p", BOT_PUBKEY]] } })],
  ])("rejects a seal with %s", (_description, wrap) => {
    expect(() => unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY)).toThrow(
      "Invalid NIP-17 direct message",
    );
  });

  it("rejects an invalid seal signature", () => {
    const validSealWrap = buildGiftWrap();
    const sealConversationKey = nip44.v2.utils.getConversationKey(WRAPPER_SECRET, BOT_PUBKEY);
    const seal = JSON.parse(
      nip44.v2.decrypt(validSealWrap.content, sealConversationKey),
    ) as NostrEvent;
    const invalidSeal = { ...seal, sig: corruptSignature(seal.sig) };
    const wrap = buildGiftWrap({ sealPlaintext: JSON.stringify(invalidSeal) });

    expect(() => unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY)).toThrow(
      "Invalid NIP-17 direct message",
    );
  });

  it.each([
    ["wrong kind", buildGiftWrap({ rumor: { kind: 15 } })],
    ["missing recipient", buildGiftWrap({ rumor: { tags: [] } })],
    ["invalid hash", buildGiftWrap({ rumor: { id: "00".repeat(32) } })],
    ["a signature", buildGiftWrap({ rumor: { sig: "00".repeat(64) } })],
    ["malformed JSON", buildGiftWrap({ rumorPlaintext: "not-json" })],
  ])("rejects a rumor with %s", (_description, wrap) => {
    expect(() => unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY)).toThrow(
      "Invalid NIP-17 direct message",
    );
  });

  it("rejects a seal and rumor whose authors do not match", () => {
    const wrap = buildGiftWrap({ rumor: { pubkey: OTHER_PUBKEY } });

    expect(() => unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY)).toThrow(
      "Invalid NIP-17 direct message",
    );
  });

  it("does not leak secret keys or plaintext through protocol errors", () => {
    const wrap = buildGiftWrap({ rumor: { content: "/link private-wireguard-key", kind: 15 } });

    let error: unknown;
    try {
      unwrapDirectMessage(wrap, BOT_SECRET, BOT_PUBKEY);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid NIP-17 direct message");
    expect((error as Error).message).not.toContain("private-wireguard-key");
    expect((error as Error).message).not.toContain(Buffer.from(BOT_SECRET).toString("hex"));
  });
});

describe("createDirectMessageReply", () => {
  it("creates a fresh gift-wrapped kind 14 reply addressed to the recipient", () => {
    const inbound = createRumor();

    const first = createDirectMessageReply(BOT_SECRET, SENDER_PUBKEY, "Pong", inbound.id);
    const second = createDirectMessageReply(BOT_SECRET, SENDER_PUBKEY, "Pong", inbound.id);

    expect(first.kind).toBe(1059);
    expect(first.tags).toEqual([["p", SENDER_PUBKEY]]);
    expect(first.pubkey).not.toBe(BOT_PUBKEY);
    expect(first.content).not.toContain("Pong");
    expect(second.id).not.toBe(first.id);
    expect(second.pubkey).not.toBe(first.pubkey);

    const rumor = unwrapDirectMessage(first, SENDER_SECRET, SENDER_PUBKEY);
    expect(rumor.pubkey).toBe(BOT_PUBKEY);
    expect(rumor.content).toBe("Pong");
    expect(rumor.tags).toContainEqual(["p", SENDER_PUBKEY]);
    expect(rumor.tags).toContainEqual(["e", inbound.id, "", "reply"]);
  });

  it("rejects invalid reply inputs with a sanitized error", () => {
    expect(() =>
      createDirectMessageReply(BOT_SECRET, "not-a-pubkey", "secret reply", "bad-id"),
    ).toThrow("Invalid NIP-17 reply");
  });
});
