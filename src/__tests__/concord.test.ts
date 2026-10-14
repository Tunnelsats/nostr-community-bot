import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  CONCORD_MANAGE_CHANNELS,
  CONCORD_MANAGE_MESSAGES,
  computeConcordCommunityId,
  computeConcordEditionHash,
  computeConcordGrantLocator,
  createConcordStreamEvent,
  decodeConcordStreamEvent,
  deriveConcordGroupKey,
  foldConcordControl,
  hasWireGuardLeak,
  validateConcordInvite,
  type ConcordControlEdition,
  type ConcordInviteBundle,
} from "../concord.js";

const OWNER_SECRET = generateSecretKey();
const OWNER = getPublicKey(OWNER_SECRET);
const BOT_SECRET = generateSecretKey();
const BOT = getPublicKey(BOT_SECRET);
const MEMBER_SECRET = generateSecretKey();
const MEMBER = getPublicKey(MEMBER_SECRET);
const OWNER_SALT = "11".repeat(32);
const ROOT = "22".repeat(32);
const CHANNEL_ID = "33".repeat(32);
const ROLE_ID = "44".repeat(32);

function invite(overrides: Partial<ConcordInviteBundle> = {}): ConcordInviteBundle {
  return {
    community_id: computeConcordCommunityId(OWNER, OWNER_SALT),
    owner: OWNER,
    owner_salt: OWNER_SALT,
    community_root: ROOT,
    root_epoch: 7,
    control_pk: "55".repeat(32),
    channels: [{ id: CHANNEL_ID, key: "66".repeat(32), epoch: 3, name: "private" }],
    relays: ["wss://relay.example"],
    name: "Test community",
    ...overrides,
  };
}

function edition(
  author: string,
  vsk: number,
  eid: string,
  content: unknown,
  version = 1,
  prev?: string,
): ConcordControlEdition {
  return {
    author,
    rumorId: `${vsk}${version}`.padEnd(64, "a").slice(0, 64),
    vsk,
    eid,
    version,
    ...(prev ? { prev } : {}),
    content: JSON.stringify(content),
  };
}

function grantCoordinate(member: string): string {
  return computeConcordGrantLocator(invite().community_id, member);
}

describe("Concord V2 wire helpers", () => {
  it("derives the frozen CORD group-key vector", () => {
    const key = deriveConcordGroupKey(
      "concord/channel",
      Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      7,
    );

    expect(Buffer.from(key.secretKey).toString("hex")).toBe(
      "a65136cc35b9287198d87bcb030bc0b16b6526d2eb5c583686b7c004b8674406",
    );
    expect(key.publicKey).toBe(
      "d8023e486aaeb2a46b5f16fdb5b13bdfd7791a0a34672f2dc1ac152affddd70d",
    );
  });

  it("accepts a bounded self-certifying invite and rejects forged or unsafe variants", () => {
    expect(validateConcordInvite(invite(), Date.now())).toEqual(invite());
    expect(validateConcordInvite(invite({ owner: MEMBER }), Date.now())).toBeNull();
    expect(
      validateConcordInvite(invite({ relays: ["wss://127.0.0.1"] }), Date.now()),
    ).toBeNull();
    expect(
      validateConcordInvite(
        invite({ expires_at: Math.floor(Date.now() / 1_000) - 1 }),
        Date.now(),
      ),
    ).toBeNull();
    expect(
      validateConcordInvite(
        invite({ channels: Array.from({ length: 257 }, () => invite().channels[0]) }),
        Date.now(),
      ),
    ).toBeNull();
  });

  it("accepts invites that omit the optional display name", () => {
    const value = { ...invite() } as Partial<ConcordInviteBundle>;
    delete value.name;

    expect(validateConcordInvite(value, Date.now())?.name).toBe("");
  });

  it("round-trips authenticated bounded channel rumors and enforces binding", () => {
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(CHANNEL_ID, "hex"),
      7,
    );
    const event = createConcordStreamEvent(BOT_SECRET, group, {
      kind: 9,
      content: "/ping node",
      tags: [
        ["channel", CHANNEL_ID],
        ["epoch", "7"],
        ["ms", "123"],
      ],
      created_at: 1_700_000_000,
    });

    const decoded = decodeConcordStreamEvent(event, group, {
      channelId: CHANNEL_ID,
      epoch: 7,
      allowedKinds: [9],
    });
    expect(decoded?.author).toBe(BOT);
    expect(decoded?.rumor.content).toBe("/ping node");
    expect(
      decodeConcordStreamEvent(event, group, {
        channelId: "77".repeat(32),
        epoch: 7,
        allowedKinds: [9],
      }),
    ).toBeNull();

    const tampered = { ...event, content: `${event.content}x` };
    expect(
      decodeConcordStreamEvent(tampered, group, {
        channelId: CHANNEL_ID,
        epoch: 7,
        allowedKinds: [9],
      }),
    ).toBeNull();
  });

  it("accepts live ephemeral wraps while emitting durable chat wraps", () => {
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(CHANNEL_ID, "hex"),
      7,
    );
    const durable = createConcordStreamEvent(BOT_SECRET, group, {
      kind: 9,
      content: "durable",
      tags: [["channel", CHANNEL_ID], ["epoch", "7"]],
      created_at: 1_700_000_000,
    });
    const ephemeral = createConcordStreamEvent(
      BOT_SECRET,
      group,
      {
        kind: 9,
        content: "live",
        tags: [["channel", CHANNEL_ID], ["epoch", "7"]],
        created_at: 1_700_000_001,
      },
      { ephemeral: true },
    );

    expect(durable.kind).toBe(1059);
    expect(ephemeral.kind).toBe(21059);
    expect(
      decodeConcordStreamEvent(ephemeral, group, {
        channelId: CHANNEL_ID,
        epoch: 7,
        allowedKinds: [9],
      })?.rumor.content,
    ).toBe("live");
  });

  it("rejects stream wraps with non-camouflage outer tags", () => {
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(CHANNEL_ID, "hex"),
      7,
    );
    const event = createConcordStreamEvent(BOT_SECRET, group, {
      kind: 9,
      content: "hello",
      tags: [["channel", CHANNEL_ID], ["epoch", "7"]],
      created_at: 1_700_000_000,
    });
    const malformed = finalizeEvent(
      {
        kind: event.kind,
        content: event.content,
        tags: [["p", BOT], ["p", MEMBER]],
        created_at: event.created_at,
      },
      group.secretKey,
    );

    expect(
      decodeConcordStreamEvent(malformed, group, {
        channelId: CHANNEL_ID,
        epoch: 7,
        allowedKinds: [9],
      }),
    ).toBeNull();
  });

  it("enforces rumor limits in UTF-8 bytes", () => {
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(CHANNEL_ID, "hex"),
      7,
    );

    expect(() =>
      createConcordStreamEvent(BOT_SECRET, group, {
        kind: 9,
        content: "😀".repeat(5_000),
        tags: [["channel", CHANNEL_ID], ["epoch", "7"]],
        created_at: 1_700_000_000,
      }),
    ).toThrow("Invalid Concord rumor");
  });
});

describe("Concord moderator authority", () => {
  it("folds owner-rooted roles and grants and requires strict rank superiority", () => {
    const memberRole = "77".repeat(32);
    const channelAdminRole = "88".repeat(32);
    const state = foldConcordControl(
      [
        edition(OWNER, 1, ROLE_ID, {
          role_id: ROLE_ID,
          name: "Moderator",
          position: 2,
          permissions: String(CONCORD_MANAGE_MESSAGES),
          scope: { kind: "server" },
        }),
        edition(OWNER, 1, channelAdminRole, {
          role_id: channelAdminRole,
          name: "Channel Admin",
          position: 3,
          permissions: String(CONCORD_MANAGE_CHANNELS),
          scope: { kind: "channel", channel_id: CHANNEL_ID },
        }),
        edition(OWNER, 1, memberRole, {
          role_id: memberRole,
          name: "Member",
          position: 10,
          permissions: "0",
          scope: { kind: "server" },
        }),
        edition(OWNER, 3, grantCoordinate(BOT), { member: BOT, role_ids: [ROLE_ID] }),
        edition(OWNER, 3, grantCoordinate(MEMBER), {
          member: MEMBER,
          role_ids: [memberRole, channelAdminRole],
        }),
      ],
      { communityId: invite().community_id, owner: OWNER },
    );

    expect(state.canManageMessages(BOT, MEMBER, CHANNEL_ID)).toBe(true);
    expect(state.canManageMessages(MEMBER, BOT, CHANNEL_ID)).toBe(false);
    expect(state.canManageMessages(OWNER, BOT, CHANNEL_ID)).toBe(true);
    expect(state.canManageMessages(OWNER, OWNER, CHANNEL_ID)).toBe(false);
    expect(state.canManageChannelOrMessages(OWNER, CHANNEL_ID)).toBe(true);
    expect(state.canManageChannelOrMessages(BOT, CHANNEL_ID)).toBe(true);
    expect(state.canManageChannelOrMessages(MEMBER, CHANNEL_ID)).toBe(true);
    expect(state.canManageChannelOrMessages(MEMBER, "99".repeat(32))).toBe(false);
  });

  it("honors channel scope and revocation while rejecting forged grants", () => {
    const otherChannel = "88".repeat(32);
    const wrongCoordinate = "99".repeat(32);
    const initialGrant = edition(OWNER, 3, grantCoordinate(BOT), {
      member: BOT,
      role_ids: [ROLE_ID],
    });
    const state = foldConcordControl(
      [
        edition(OWNER, 1, ROLE_ID, {
          role_id: ROLE_ID,
          name: "Channel moderator",
          position: 2,
          permissions: String(CONCORD_MANAGE_MESSAGES),
          scope: { kind: "channel", channel_id: CHANNEL_ID },
        }),
        edition(OWNER, 3, wrongCoordinate, { member: MEMBER, role_ids: [ROLE_ID] }),
        initialGrant,
        edition(
          OWNER,
          3,
          grantCoordinate(BOT),
          { member: BOT, role_ids: [] },
          2,
          computeConcordEditionHash(initialGrant),
        ),
      ],
      { communityId: invite().community_id, owner: OWNER },
    );

    expect(state.canManageMessages(BOT, MEMBER, CHANNEL_ID)).toBe(false);
    expect(state.canManageMessages(BOT, MEMBER, otherChannel)).toBe(false);
    expect(state.roleIdsFor(MEMBER)).toEqual([]);
  });

  it("keeps channel deletion terminal", () => {
    const deletion = edition(OWNER, 2, CHANNEL_ID, {
      name: "general",
      private: false,
      deleted: true,
    });
    const state = foldConcordControl(
      [
        deletion,
        edition(OWNER, 2, CHANNEL_ID, {
          name: "general again",
          private: false,
        }, 2, computeConcordEditionHash(deletion)),
      ],
      { communityId: invite().community_id, owner: OWNER },
    );

    expect(state.channels).toEqual([
      {
        channelId: CHANNEL_ID,
        name: "general",
        private: false,
        deleted: true,
      },
    ]);
  });

  it("ignores an edition that skips its predecessor", () => {
    const state = foldConcordControl(
      [
        edition(OWNER, 2, CHANNEL_ID, { name: "general", private: false }),
        edition(OWNER, 2, CHANNEL_ID, { name: "forged jump", private: true }, 2),
      ],
      { communityId: invite().community_id, owner: OWNER },
    );

    expect(state.channels[0]?.name).toBe("general");
    expect(state.channels[0]?.private).toBe(false);
  });

  it("refuses to downgrade a compacted grant baseline after a stale replay", () => {
    const state = foldConcordControl(
      [
        edition(OWNER, 1, ROLE_ID, {
          role_id: ROLE_ID,
          name: "Moderator",
          position: 2,
          permissions: String(CONCORD_MANAGE_MESSAGES),
          scope: { kind: "server" },
        }),
        edition(
          OWNER,
          3,
          grantCoordinate(BOT),
          { member: BOT, role_ids: [ROLE_ID] },
          2,
        ),
        edition(OWNER, 3, grantCoordinate(BOT), { member: BOT, role_ids: [] }, 5),
      ],
      { communityId: invite().community_id, owner: OWNER },
    );

    expect(state.canManageMessages(BOT, MEMBER, CHANNEL_ID)).toBe(false);
  });
});

describe("WireGuard leak detection", () => {
  it.each([
    "/link AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "/unlink AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "please use key AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= here",
    "  /LiNk definitely-sensitive  ",
    "  /UnLiNk definitely-sensitive  ",
  ])("detects sensitive public content: %s", (content) => {
    expect(hasWireGuardLeak(content)).toBe(true);
  });

  it.each([
    "/link",
    "/unlink",
    "ordinary message",
    "short base64: YWJjZA==",
    "embeddedAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=value",
  ])("does not overmatch ordinary content: %s", (content) => {
    expect(hasWireGuardLeak(content)).toBe(false);
  });
});

describe("Concord invite compatibility and diagnostics", () => {
  it("validates Armada-style invite bundle where control_pk is omitted and creator_npub is npub1", () => {
    const validInvite = invite();
    const armadaInvite: Record<string, unknown> = {
      ...validInvite,
      creator_npub: "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
    };
    delete armadaInvite.control_pk;
    const validated = validateConcordInvite(armadaInvite);
    expect(validated).not.toBeNull();
    expect(validated?.control_pk).toBe(
      deriveConcordGroupKey(
        "concord/control",
        Buffer.from(validInvite.community_root, "hex"),
        Buffer.from(validInvite.community_id, "hex"),
        validInvite.root_epoch,
      ).publicKey,
    );
    expect(validated?.creator_npub).toBe("npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6");
  });
  it("rejects an npub with an invalid bech32 checksum", () => {
    expect(
      validateConcordInvite(invite({ creator_npub: `npub1${"z".repeat(58)}` })),
    ).toBeNull();
  });

  it("does not include decrypted invite keys in validation diagnostics", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      expect(validateConcordInvite(invite({ owner: "invalid" }))).toBeNull();
      expect(JSON.stringify(debug.mock.calls)).not.toContain(ROOT);
      expect(JSON.stringify(debug.mock.calls)).not.toContain(OWNER_SALT);
    } finally {
      debug.mockRestore();
    }
  });
});
