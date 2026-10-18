import { beforeEach, describe, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { generateSecretKey, getPublicKey, type NostrEvent } from "nostr-tools/pure";
import {
  CONCORD_CONTROL_KIND,
  CONCORD_DIRECT_INVITE_KIND,
  CONCORD_JOIN_KIND,
  CONCORD_MANAGE_MESSAGES,
  computeConcordCommunityId,
  computeConcordEditionHash,
  computeConcordGrantLocator,
  createConcordStreamEvent,
  decodeConcordStreamEvent,
  deriveConcordGroupKey,
  type ConcordInviteBundle,
  type ConcordRumor,
} from "../concord.js";
import {
  CONCORD_PRIVACY_ADVISORY,
  ConcordCommunityManager,
  MAX_CONCORD_CHANNEL_SUBSCRIPTIONS,
  type ChannelCommandMetadata,
  type ConcordRelayTransport,
} from "../concord-manager.js";
import type { PersistedConcordCommunity } from "../types.js";

const BOT_SECRET = generateSecretKey();
const BOT = getPublicKey(BOT_SECRET);
const OWNER_SECRET = generateSecretKey();
const OWNER = getPublicKey(OWNER_SECRET);
const MEMBER_SECRET = generateSecretKey();
const MEMBER = getPublicKey(MEMBER_SECRET);
const ROOT = "11".repeat(32);
const OWNER_SALT = "22".repeat(32);
const COMMUNITY_ID = computeConcordCommunityId(OWNER, OWNER_SALT);
const PRIVATE_CHANNEL = "33".repeat(32);
const PUBLIC_CHANNEL = "44".repeat(32);
const PRIVATE_KEY = "55".repeat(32);
const CONTROL_SIGNER_SECRET = generateSecretKey();
const CONTROL_PK = getPublicKey(CONTROL_SIGNER_SECRET);
const RELAYS = ["wss://community.example"];

interface Subscription {
  filter: { kinds?: number[]; authors?: string[] };
  handler(event: NostrEvent): Promise<void> | void;
  disposed: boolean;
}

interface Harness {
  manager: ConcordCommunityManager;
  transport: ConcordRelayTransport;
  subscriptions: Subscription[];
  published: NostrEvent[];
  persistedCommunities: PersistedConcordCommunity[];
  addRelays: ReturnType<typeof vi.fn<(relays: string[]) => Promise<void>>>;
  publishToRelays: ReturnType<
    typeof vi.fn<(event: NostrEvent, relays: string[]) => Promise<void>>
  >;
  sendDirectMessage: ReturnType<
    typeof vi.fn<(recipientPubkey: string, message: string) => Promise<void>>
  >;
  isFreshEvent: ReturnType<typeof vi.fn<(createdAt: number) => boolean>>;
  processMessage: ReturnType<
    typeof vi.fn<
      (
        text: string,
        sender: string,
        eventId: string,
        reply: (message: string) => Promise<void>,
        metadata?: ChannelCommandMetadata,
      ) => Promise<boolean>
    >
  >;
}

function bundle(): ConcordInviteBundle {
  return {
    community_id: COMMUNITY_ID,
    owner: OWNER,
    owner_salt: OWNER_SALT,
    community_root: ROOT,
    root_epoch: 2,
    control_pk: CONTROL_PK,
    channels: [{ id: PRIVATE_CHANNEL, key: PRIVATE_KEY, epoch: 4, name: "private" }],
    relays: RELAYS,
    name: "Community",
  };
}

function directInviteRumor(payload = bundle()): ConcordRumor {
  const rumor = {
    kind: CONCORD_DIRECT_INVITE_KIND,
    pubkey: OWNER,
    content: JSON.stringify(payload),
    tags: [],
    created_at: 1_700_000_000,
  };
  return { ...rumor, id: "aa".repeat(32) };
}

function createHarness(): Harness {
  const subscriptions: Subscription[] = [];
  const published: NostrEvent[] = [];
  const persistedCommunities: PersistedConcordCommunity[] = [];
  const addRelays = vi.fn<(relays: string[]) => Promise<void>>().mockResolvedValue();
  const publishToRelays = vi.fn<(event: NostrEvent, relays: string[]) => Promise<void>>(
    async (event) => {
      published.push(event);
    },
  );
  const sendDirectMessage = vi
    .fn<(recipientPubkey: string, message: string) => Promise<void>>()
    .mockResolvedValue();
  const isFreshEvent = vi.fn<(createdAt: number) => boolean>(() => true);
  const transport: ConcordRelayTransport = {
    addRelays,
    registerSubscription: vi.fn((filter, handler) => {
      const subscription = { filter, handler, disposed: false };
      subscriptions.push(subscription);
      return () => {
        subscription.disposed = true;
      };
    }),
    publishToRelays,
  };
  const processMessage = vi.fn<
    (
      text: string,
      sender: string,
      eventId: string,
      reply: (message: string) => Promise<void>,
      metadata?: ChannelCommandMetadata,
    ) => Promise<boolean>
  >(async (_text, _sender, _eventId, reply) => {
    await reply("Pong");
    return true;
  });
  return {
    manager: new ConcordCommunityManager({
      secretKey: BOT_SECRET,
      pubkey: BOT,
      relayTransport: transport,
      processMessage,
      isFreshEvent,
      sendDirectMessage,
      store: {
        loadCommunities: () => [...persistedCommunities],
        saveCommunity: (community) => {
          const idx = persistedCommunities.findIndex(
            (item) => item.bundle.community_id === community.bundle.community_id,
          );
          if (idx >= 0) {
            persistedCommunities[idx] = community;
          } else {
            persistedCommunities.push(community);
          }
        },
      },
      now: () => 1_700_000_000_123,
    }),
    transport,
    subscriptions,
    published,
    persistedCommunities,
    addRelays,
    publishToRelays,
    sendDirectMessage,
    isFreshEvent,
    processMessage,
  };
}

function findSubscription(publicKey: string): Subscription {
  const subscription = currentHarness.subscriptions.find(
    ({ filter, disposed }) => !disposed && filter.authors?.[0] === publicKey,
  );
  if (!subscription) throw new Error(`missing subscription ${publicKey}`);
  return subscription;
}

async function grantModerator(harness: Harness, targetMember = BOT): Promise<void> {
  const controlRead = deriveConcordGroupKey(
    "concord/control",
    Buffer.from(ROOT, "hex"),
    Buffer.from(COMMUNITY_ID, "hex"),
    2,
  );
  const controlGroup = {
    ...controlRead,
    secretKey: CONTROL_SIGNER_SECRET,
    publicKey: CONTROL_PK,
  };
  const roleId = "77".repeat(32);
  const role = createConcordStreamEvent(
    OWNER_SECRET,
    controlGroup,
    {
      kind: CONCORD_CONTROL_KIND,
      content: JSON.stringify({
        role_id: roleId,
        name: "Moderator",
        position: 2,
        permissions: String(CONCORD_MANAGE_MESSAGES),
        scope: { kind: "server" },
      }),
      tags: [["vsk", "1"], ["eid", roleId], ["ev", "1"]],
      created_at: 1_700_000_000,
    },
    { sealKind: 20014 },
  );
  const grant = createConcordStreamEvent(
    OWNER_SECRET,
    controlGroup,
    {
      kind: CONCORD_CONTROL_KIND,
      content: JSON.stringify({ member: targetMember, role_ids: [roleId] }),
      tags: [
        ["vsk", "3"],
        ["eid", computeConcordGrantLocator(COMMUNITY_ID, targetMember)],
        ["ev", "1"],
      ],
      created_at: 1_700_000_001,
    },
    { sealKind: 20014 },
  );
  const subscription = harness.subscriptions.find(
    ({ filter }) => filter.authors?.[0] === CONTROL_PK,
  );
  if (!subscription) throw new Error("missing control subscription");
  await subscription.handler(role);
  await subscription.handler(grant);
}

let currentHarness: Harness;

beforeEach(() => {
  currentHarness = createHarness();
});

describe("ConcordCommunityManager", () => {
  it("redacts invite names and emits lifecycle diagnostics once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await currentHarness.manager.acceptDirectInvite(
        directInviteRumor({ ...bundle(), name: "private\ncommunity" }),
      );

      const messages = log.mock.calls.map(([message]) => String(message));
      expect(messages.join("\n")).not.toContain("private");
      expect(
        messages.filter((message) => message.includes("Publishing Kind 3306 Join")),
      ).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes("Subscribed to invite channel")),
      ).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes("relay registration completed")),
      ).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("accepts an invite, follows control/guestbook/private streams, and publishes a Join", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());

    expect(currentHarness.addRelays).toHaveBeenCalledWith(RELAYS);
    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const privateGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const guestbook = deriveConcordGroupKey(
      "concord/guestbook",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    expect(findSubscription(CONTROL_PK).filter.kinds).toEqual([1059, 21059]);
    expect(findSubscription(guestbook.publicKey).filter.kinds).toEqual([1059, 21059]);
    expect(findSubscription(privateGroup.publicKey).filter.kinds).toEqual([1059, 21059]);
    expect(currentHarness.published).toHaveLength(1);
    expect(
      decodeConcordStreamEvent(currentHarness.published[0], guestbook, {
        allowedKinds: [CONCORD_JOIN_KIND],
      })?.rumor.content,
    ).toBe("join");
    expect(controlRead.conversationKey).toHaveLength(32);
    expect(currentHarness.persistedCommunities).toEqual([
      { bundle: bundle(), joinPublished: true },
    ]);
  });

  it("restores persisted communities without republishing duplicate Join events even when original invite expires_at has passed", async () => {
    currentHarness.persistedCommunities.push({
      bundle: {
        ...bundle(),
        expires_at: 1_600_000_000,
      },
      joinPublished: true,
    });

    await currentHarness.manager.restoreCommunities();

    expect(currentHarness.addRelays).toHaveBeenCalledWith(RELAYS);
    expect(currentHarness.published).toHaveLength(0);
    const privateGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    expect(findSubscription(privateGroup.publicKey)).toBeDefined();
  });

  it("retries the Join publication after a transient relay failure and persists joinPublished=false before publishing", async () => {
    currentHarness.publishToRelays.mockRejectedValueOnce(new Error("relay unavailable"));

    await expect(
      currentHarness.manager.acceptDirectInvite(directInviteRumor()),
    ).rejects.toThrow("relay unavailable");
    expect(currentHarness.persistedCommunities).toEqual([
      { bundle: bundle(), joinPublished: false },
    ]);

    await currentHarness.manager.acceptDirectInvite(directInviteRumor());

    expect(currentHarness.published).toHaveLength(1);
    expect(currentHarness.persistedCommunities).toEqual([
      { bundle: bundle(), joinPublished: true },
    ]);
  });

  it("does not publish another Join for a differently wrapped duplicate invite", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());

    await currentHarness.manager.acceptDirectInvite({
      ...directInviteRumor(),
      id: "bb".repeat(32),
    });

    expect(currentHarness.published).toHaveLength(1);
  });

  it("caps channel subscriptions across unsolicited communities", async () => {
    const fullBundle = {
      ...bundle(),
      channels: Array.from(
        { length: MAX_CONCORD_CHANNEL_SUBSCRIPTIONS },
        (_, index) => ({
          id: (index + 1).toString(16).padStart(64, "0"),
          key: PRIVATE_KEY,
          epoch: 1,
        }),
      ),
    };
    await currentHarness.manager.acceptDirectInvite(directInviteRumor(fullBundle));
    const otherSalt = "99".repeat(32);
    const secondInvite = directInviteRumor({
      ...bundle(),
      community_id: computeConcordCommunityId(OWNER, otherSalt),
      owner_salt: otherSalt,
      community_root: "88".repeat(32),
      channels: [{ id: "77".repeat(32), key: "66".repeat(32), epoch: 1 }],
    });

    await currentHarness.manager.acceptDirectInvite({
      ...secondInvite,
      id: "bb".repeat(32),
    });

    expect(currentHarness.addRelays).toHaveBeenCalledTimes(1);
    expect(currentHarness.published).toHaveLength(1);
  });

  it("dispatches allowed channel commands with metadata and sends sealed kind-9 channel replies", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    currentHarness.published.length = 0;
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const subscription = findSubscription(group.publicKey);
    const ping = createConcordStreamEvent(MEMBER_SECRET, group, {
      kind: 9,
      content: "/ping node",
      tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
      created_at: 1_700_000_000,
    });
    await subscription.handler(ping);

    expect(currentHarness.processMessage).toHaveBeenCalledWith(
      "/ping node",
      MEMBER,
      expect.any(String),
      expect.any(Function),
      {
        transport: "concord-channel",
        communityId: COMMUNITY_ID,
        channelId: PRIVATE_CHANNEL,
        channelName: "private",
        isModerator: false,
        senderRole: "member",
      },
    );
    expect(currentHarness.published).toHaveLength(1);
    const reply = decodeConcordStreamEvent(currentHarness.published[0], group, {
      channelId: PRIVATE_CHANNEL,
      epoch: 4,
      allowedKinds: [9],
    });
    expect(reply?.author).toBe(BOT);
    expect(reply?.rumor.content).toBe("Pong");

    currentHarness.processMessage.mockClear();
    currentHarness.published.length = 0;
    const privateCommand = createConcordStreamEvent(MEMBER_SECRET, group, {
      kind: 9,
      content: "/tunnelsats",
      tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
      created_at: 1_700_000_001,
    });
    await subscription.handler(privateCommand);
    expect(currentHarness.processMessage).not.toHaveBeenCalled();
    expect(currentHarness.published).toHaveLength(0);
  });

  it("handles Guestbook Kind 3306 member joins and publishes welcome messages to #general", async () => {
    const onMemberJoin = vi.fn(async (ctx) => {
      await ctx.replyChannel(`Welcome nostr:${ctx.memberNpub}!`);
      await ctx.sendDirectMessage("Private onboarding guide");
    });
    currentHarness.manager.setOnMemberJoin(onMemberJoin);
    await currentHarness.manager.acceptDirectInvite(
      directInviteRumor({
        ...bundle(),
        channels: [
          { id: PRIVATE_CHANNEL, key: PRIVATE_KEY, epoch: 4, name: "announcements" },
          { id: PUBLIC_CHANNEL, key: PRIVATE_KEY, epoch: 4, name: "general" },
        ],
      }),
    );
    currentHarness.published.length = 0;

    const guestbook = deriveConcordGroupKey(
      "concord/guestbook",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const guestbookSub = findSubscription(guestbook.publicKey);

    // Self-join must be ignored.
    const selfJoin = createConcordStreamEvent(BOT_SECRET, guestbook, {
      kind: CONCORD_JOIN_KIND,
      content: "join",
      tags: [["ms", "100"]],
      created_at: 1_700_000_001,
    });
    await guestbookSub.handler(selfJoin);
    expect(onMemberJoin).not.toHaveBeenCalled();

    // New member join triggers onMemberJoin and posts to #general with ["p", member].
    const memberJoin = createConcordStreamEvent(MEMBER_SECRET, guestbook, {
      kind: CONCORD_JOIN_KIND,
      content: "join",
      tags: [["ms", "200"]],
      created_at: 1_700_000_002,
    });
    await guestbookSub.handler(memberJoin);

    expect(onMemberJoin).toHaveBeenCalledTimes(1);
    expect(onMemberJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        communityName: "Community",
        memberPubkey: MEMBER,
        memberNpub: nip19.npubEncode(MEMBER),
        defaultChannelId: PUBLIC_CHANNEL,
        defaultChannelName: "general",
      }),
    );
    expect(currentHarness.sendDirectMessage).toHaveBeenCalledWith(
      MEMBER,
      "Private onboarding guide",
    );
    expect(currentHarness.published).toHaveLength(1);
    const generalGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PUBLIC_CHANNEL, "hex"),
      4,
    );
    const welcomeDecoded = decodeConcordStreamEvent(
      currentHarness.published[0],
      generalGroup,
      {
        channelId: PUBLIC_CHANNEL,
        epoch: 4,
        allowedKinds: [9],
      },
    );
    expect(welcomeDecoded?.rumor.content).toContain(nip19.npubEncode(MEMBER));
    expect(welcomeDecoded?.rumor.tags).toContainEqual(["p", MEMBER]);
  });

  it("triggers onChannelMention for @TunnelSats, npub, or direct p-tag and ignores thread replies without explicit mention", async () => {
    const onChannelMention = vi.fn(async (ctx) => {
      await ctx.reply(`Hi nostr:${ctx.senderNpub}!`);
    });
    currentHarness.manager.setOnChannelMention(onChannelMention);
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    await grantModerator(currentHarness, MEMBER);
    currentHarness.published.length = 0;

    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const sub = findSubscription(group.publicKey);

    // 1. Thread reply with ["e", ...] and ["p", BOT] but no explicit text mention -> ignored
    const threadReply = createConcordStreamEvent(MEMBER_SECRET, group, {
      kind: 9,
      content: "Thanks for the info!",
      tags: [
        ["channel", PRIVATE_CHANNEL],
        ["epoch", "4"],
        ["e", "99".repeat(32)],
        ["p", BOT],
      ],
      created_at: 1_700_000_005,
    });
    await sub.handler(threadReply);
    expect(onChannelMention).not.toHaveBeenCalled();

    // 2. Explicit @TunnelSats mention -> handled with isModerator: true
    const mentionEvent = createConcordStreamEvent(MEMBER_SECRET, group, {
      kind: 9,
      content: "Hey @TunnelSats how do I get started?",
      tags: [
        ["channel", PRIVATE_CHANNEL],
        ["epoch", "4"],
      ],
      created_at: 1_700_000_006,
    });
    await sub.handler(mentionEvent);

    expect(onChannelMention).toHaveBeenCalledTimes(1);
    expect(onChannelMention).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId: COMMUNITY_ID,
        channelId: PRIVATE_CHANNEL,
        channelName: "private",
        senderPubkey: MEMBER,
        senderNpub: nip19.npubEncode(MEMBER),
        content: "Hey @TunnelSats how do I get started?",
        isModerator: true,
        senderRole: "moderator",
      }),
    );
    expect(currentHarness.published).toHaveLength(1);
    const replyDecoded = decodeConcordStreamEvent(currentHarness.published[0], group, {
      channelId: PRIVATE_CHANNEL,
      epoch: 4,
      allowedKinds: [9],
    });
    expect(replyDecoded?.rumor.content).toBe(`Hi nostr:${nip19.npubEncode(MEMBER)}!`);
    expect(replyDecoded?.rumor.tags).toContainEqual(["p", MEMBER]);
  });

  it("publishes proactive channel messages by explicit ID or default alias", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    currentHarness.published.length = 0;

    await currentHarness.manager.publishChannelMessage(
      "default",
      PRIVATE_CHANNEL,
      "Scheduled server status update",
    );

    expect(currentHarness.published).toHaveLength(1);
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const decoded = decodeConcordStreamEvent(currentHarness.published[0], group, {
      channelId: PRIVATE_CHANNEL,
      epoch: 4,
      allowedKinds: [9],
    });
    expect(decoded?.rumor.content).toBe("Scheduled server status update");

    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const controlGroup = {
      ...controlRead,
      secretKey: CONTROL_SIGNER_SECRET,
      publicKey: CONTROL_PK,
    };
    await findSubscription(CONTROL_PK).handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({ name: "general", private: false }),
          tags: [["vsk", "2"], ["eid", PUBLIC_CHANNEL], ["ev", "1"]],
          created_at: 1_700_000_000,
        },
        { sealKind: 20014 },
      ),
    );
    currentHarness.published.length = 0;

    await currentHarness.manager.publishChannelMessage(
      "default",
      "default",
      "Public server status update",
    );

    expect(currentHarness.published).toHaveLength(1);
    const publicGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(PUBLIC_CHANNEL, "hex"),
      2,
    );
    const publicDecoded = decodeConcordStreamEvent(
      currentHarness.published[0],
      publicGroup,
      {
        channelId: PUBLIC_CHANNEL,
        epoch: 2,
        allowedKinds: [9],
      },
    );
    expect(publicDecoded?.rumor.content).toBe("Public server status update");
  });

  it("folds public channels from Control and begins handling #general", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const controlGroup = {
      ...controlRead,
      secretKey: CONTROL_SIGNER_SECRET,
      publicKey: CONTROL_PK,
    };
    const channelEdition = createConcordStreamEvent(
      OWNER_SECRET,
      controlGroup,
      {
        kind: CONCORD_CONTROL_KIND,
        content: JSON.stringify({ name: "general", private: false }),
        tags: [["vsk", "2"], ["eid", PUBLIC_CHANNEL], ["ev", "1"]],
        created_at: 1_700_000_000,
      },
      { sealKind: 20014 },
    );
    await findSubscription(CONTROL_PK).handler(channelEdition);

    const publicGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(PUBLIC_CHANNEL, "hex"),
      2,
    );
    expect(findSubscription(publicGroup.publicKey)).toBeDefined();
  });

  it("stops consuming an obsolete public stream when a channel becomes private", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const controlGroup = {
      ...controlRead,
      secretKey: CONTROL_SIGNER_SECRET,
      publicKey: CONTROL_PK,
    };
    const publicEdition = createConcordStreamEvent(
      OWNER_SECRET,
      controlGroup,
      {
        kind: CONCORD_CONTROL_KIND,
        content: JSON.stringify({ name: "general", private: false }),
        tags: [["vsk", "2"], ["eid", PUBLIC_CHANNEL], ["ev", "1"]],
        created_at: 1_700_000_000,
      },
      { sealKind: 20014 },
    );
    const privateEdition = createConcordStreamEvent(
      OWNER_SECRET,
      controlGroup,
      {
        kind: CONCORD_CONTROL_KIND,
        content: JSON.stringify({ name: "general", private: true }),
        tags: [
          ["vsk", "2"],
          ["eid", PUBLIC_CHANNEL],
          ["ev", "2"],
          [
            "ep",
            computeConcordEditionHash({
              author: OWNER,
              rumorId: "00".repeat(32),
              vsk: 2,
              eid: PUBLIC_CHANNEL,
              version: 1,
              content: JSON.stringify({ name: "general", private: false }),
            }),
          ],
        ],
        created_at: 1_700_000_001,
      },
      { sealKind: 20014 },
    );
    const controlSubscription = findSubscription(CONTROL_PK);
    await controlSubscription.handler(publicEdition);
    const publicGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(PUBLIC_CHANNEL, "hex"),
      2,
    );
    const obsoleteSubscription = findSubscription(publicGroup.publicKey);

    await controlSubscription.handler(privateEdition);

    expect(obsoleteSubscription.disposed).toBe(true);
    await obsoleteSubscription.handler(
      createConcordStreamEvent(MEMBER_SECRET, publicGroup, {
        kind: 9,
        content: "/ping",
        tags: [["channel", PUBLIC_CHANNEL], ["epoch", "2"]],
        created_at: 1_700_000_002,
      }),
    );
    expect(currentHarness.processMessage).not.toHaveBeenCalled();
  });

  it("redacts a key leak only after verified moderator authority and posts no secret", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    await grantModerator(currentHarness);

    currentHarness.published.length = 0;
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const leak = createConcordStreamEvent(MEMBER_SECRET, group, {
      kind: 9,
      content: `/link ${secret}`,
      tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
      created_at: 1_700_000_002,
    });
    const leakRumor = decodeConcordStreamEvent(leak, group, {
      channelId: PRIVATE_CHANNEL,
      epoch: 4,
      allowedKinds: [9],
    })!.rumor;
    await findSubscription(group.publicKey).handler(leak);

    expect(currentHarness.processMessage).not.toHaveBeenCalled();
    expect(currentHarness.published).toHaveLength(2);
    const deletion = decodeConcordStreamEvent(currentHarness.published[0], group, {
      channelId: PRIVATE_CHANNEL,
      epoch: 4,
      allowedKinds: [5],
    });
    const advisory = decodeConcordStreamEvent(currentHarness.published[1], group, {
      channelId: PRIVATE_CHANNEL,
      epoch: 4,
      allowedKinds: [9],
    });
    expect(deletion?.rumor.tags).toContainEqual(["e", leakRumor.id]);
    expect(deletion?.rumor.tags).toContainEqual(["p", MEMBER]);
    expect(advisory?.rumor.content).toBe(CONCORD_PRIVACY_ADVISORY);
    expect(JSON.stringify(currentHarness.published)).not.toContain(secret);
  });

  it("does not publish the advisory when deletion publication fails", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    await grantModerator(currentHarness);
    currentHarness.published.length = 0;
    currentHarness.publishToRelays.mockRejectedValueOnce(new Error("relay unavailable"));
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const leak = createConcordStreamEvent(MEMBER_SECRET, group, {
      kind: 9,
      content: "/link definitely-sensitive",
      tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
      created_at: 1_700_000_002,
    });

    await expect(findSubscription(group.publicKey).handler(leak)).rejects.toThrow(
      "relay unavailable",
    );
    expect(currentHarness.publishToRelays).toHaveBeenCalledTimes(2);
    expect(currentHarness.published).toHaveLength(0);
  });

  it("does not claim redaction without verified moderator authority", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const leak = createConcordStreamEvent(MEMBER_SECRET, group, {
      kind: 9,
      content: "/link definitely-sensitive",
      tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
      created_at: 1_700_000_002,
    });

    // No folded moderator permission means no deletion and no misleading advisory.
    currentHarness.published.length = 0;
    await currentHarness.subscriptions
      .find(({ filter }) => filter.authors?.[0] === group.publicKey)!
      .handler(leak);
    expect(currentHarness.published).toHaveLength(0);
  });

  it("ignores duplicate channel wraps and clears subscriptions on stop", async () => {
    await currentHarness.manager.acceptDirectInvite(directInviteRumor());
    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const ping = createConcordStreamEvent(MEMBER_SECRET, group, {
      kind: 9,
      content: "/help",
      tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
      created_at: 1_700_000_000,
    });
    const subscription = findSubscription(group.publicKey);
    await subscription.handler(ping);
    await subscription.handler(ping);
    expect(currentHarness.processMessage).toHaveBeenCalledTimes(1);

    currentHarness.manager.stop();
    await subscription.handler(
      createConcordStreamEvent(MEMBER_SECRET, group, {
        kind: 9,
        content: "/help",
        tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
        created_at: 1_700_000_001,
      }),
    );
    expect(currentHarness.processMessage).toHaveBeenCalledTimes(1);
  });

  it("resolves getMemberRole and dispatches senderRole for owner, admin, moderator, and member", async () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const modSecret = generateSecretKey();
    const modPubkey = getPublicKey(modSecret);

    await currentHarness.manager.acceptDirectInvite(directInviteRumor());

    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const controlGroup = {
      ...controlRead,
      secretKey: CONTROL_SIGNER_SECRET,
      publicKey: CONTROL_PK,
    };
    const adminRoleId = "81".repeat(32);
    const modRoleId = "82".repeat(32);
    const controlSub = findSubscription(CONTROL_PK);

    await controlSub.handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({
            role_id: adminRoleId,
            name: "Admin",
            position: 1,
            permissions: "0",
            scope: { kind: "server" },
          }),
          tags: [["vsk", "1"], ["eid", adminRoleId], ["ev", "1"]],
          created_at: 1_700_000_000,
        },
        { sealKind: 20014 },
      ),
    );
    await controlSub.handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({
            role_id: modRoleId,
            name: "Moderator",
            position: 2,
            permissions: String(CONCORD_MANAGE_MESSAGES),
            scope: { kind: "channel", channel_id: PRIVATE_CHANNEL },
          }),
          tags: [["vsk", "1"], ["eid", modRoleId], ["ev", "1"]],
          created_at: 1_700_000_001,
        },
        { sealKind: 20014 },
      ),
    );
    await controlSub.handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({ member: adminPubkey, role_ids: [adminRoleId] }),
          tags: [
            ["vsk", "3"],
            ["eid", computeConcordGrantLocator(COMMUNITY_ID, adminPubkey)],
            ["ev", "1"],
          ],
          created_at: 1_700_000_002,
        },
        { sealKind: 20014 },
      ),
    );
    await controlSub.handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({ member: modPubkey, role_ids: [modRoleId] }),
          tags: [
            ["vsk", "3"],
            ["eid", computeConcordGrantLocator(COMMUNITY_ID, modPubkey)],
            ["ev", "1"],
          ],
          created_at: 1_700_000_003,
        },
        { sealKind: 20014 },
      ),
    );

    expect(currentHarness.manager.getMemberRole(OWNER)).toBe("owner");
    expect(currentHarness.manager.getMemberRole(adminPubkey)).toBe("admin");
    expect(currentHarness.manager.getMemberRole(modPubkey)).toBe("moderator");
    expect(currentHarness.manager.getMemberRole(MEMBER)).toBe("member");

    const group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(PRIVATE_CHANNEL, "hex"),
      4,
    );
    const channelSub = findSubscription(group.publicKey);

    for (const [secret, expectedRole, expectedMod] of [
      [OWNER_SECRET, "owner", true],
      [adminSecret, "admin", true],
      [modSecret, "moderator", true],
      [MEMBER_SECRET, "member", false],
    ] as const) {
      currentHarness.processMessage.mockClear();
      await channelSub.handler(
        createConcordStreamEvent(secret, group, {
          kind: 9,
          content: "/setwelcome Welcome!",
          tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
          created_at: 1_700_000_010,
        }),
      );
      expect(currentHarness.processMessage).toHaveBeenCalledWith(
        "/setwelcome Welcome!",
        getPublicKey(secret),
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({
          senderRole: expectedRole,
          isModerator: expectedMod,
        }),
      );
    }
  });

  it("suppresses startup log spam for historical or duplicate stream wraps and logs fresh Kind 9 messages once", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await currentHarness.manager.acceptDirectInvite(directInviteRumor());
      logSpy.mockClear();

      const group = deriveConcordGroupKey(
        "concord/channel",
        Buffer.from(PRIVATE_KEY, "hex"),
        Buffer.from(PRIVATE_CHANNEL, "hex"),
        4,
      );
      const channelSub = findSubscription(group.publicKey);

      currentHarness.isFreshEvent.mockReturnValueOnce(false);
      const staleWrap = createConcordStreamEvent(MEMBER_SECRET, group, {
        kind: 9,
        content: "/ping",
        tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
        created_at: 1_699_999_000,
      });
      await channelSub.handler(staleWrap);
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Received stream wrap"),
      );
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("[Concord] Decrypted Kind 9 message"),
      );

      const freshWrap = createConcordStreamEvent(MEMBER_SECRET, group, {
        kind: 9,
        content: "/ping",
        tags: [["channel", PRIVATE_CHANNEL], ["epoch", "4"]],
        created_at: 1_700_000_020,
      });
      await channelSub.handler(freshWrap);
      await channelSub.handler(freshWrap);

      const decryptedLogs = logSpy.mock.calls.filter(([msg]) =>
        typeof msg === "string" && msg.includes("[Concord] Decrypted Kind 9 message"),
      );
      expect(decryptedLogs).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prevents resolveDefaultChannel and onMemberJoin from falling back to a private invite channel before #general is folded", async () => {
    const notificationsChannelId =
      "0daff3a90287ce6bef9a4f372aaa7b5689178ad5ec47c1647df22169b42cb314";
    const onMemberJoin = vi.fn();
    currentHarness.manager.setOnMemberJoin(onMemberJoin);

    await currentHarness.manager.acceptDirectInvite(
      directInviteRumor({
        ...bundle(),
        channels: [
          {
            id: notificationsChannelId,
            key: PRIVATE_KEY,
            epoch: 1,
            name: "Notifications",
          },
        ],
      }),
    );
    currentHarness.published.length = 0;

    const guestbook = deriveConcordGroupKey(
      "concord/guestbook",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const guestbookSub = findSubscription(guestbook.publicKey);

    // Join event arrives before Control folds public #general
    const earlyJoin = createConcordStreamEvent(MEMBER_SECRET, guestbook, {
      kind: CONCORD_JOIN_KIND,
      content: "join",
      tags: [["ms", "100"]],
      created_at: 1_700_000_010,
    });
    await guestbookSub.handler(earlyJoin);

    expect(onMemberJoin).toHaveBeenCalledTimes(1);
    const earlyCtx = onMemberJoin.mock.calls[0][0];
    expect(earlyCtx.defaultChannelId).toBeUndefined();
    expect(earlyCtx.defaultChannelName).toBeUndefined();
    await expect(earlyCtx.replyChannel("Welcome!")).rejects.toThrow(
      "No active Concord channel available for welcome message",
    );
    expect(currentHarness.published).toHaveLength(0);

    // Now Control folds public #general (private: false) and marks Notifications as private: true
    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const controlGroup = {
      ...controlRead,
      secretKey: CONTROL_SIGNER_SECRET,
      publicKey: CONTROL_PK,
    };
    const controlSub = findSubscription(CONTROL_PK);
    await controlSub.handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({ name: "Notifications", private: true }),
          tags: [["vsk", "2"], ["eid", notificationsChannelId], ["ev", "1"]],
          created_at: 1_700_000_011,
        },
        { sealKind: 20014 },
      ),
    );
    await controlSub.handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({ name: "general", private: false }),
          tags: [["vsk", "2"], ["eid", PUBLIC_CHANNEL], ["ev", "1"]],
          created_at: 1_700_000_012,
        },
        { sealKind: 20014 },
      ),
    );

    const secondMemberSecret = generateSecretKey();
    const secondMember = getPublicKey(secondMemberSecret);
    const lateJoin = createConcordStreamEvent(secondMemberSecret, guestbook, {
      kind: CONCORD_JOIN_KIND,
      content: "join",
      tags: [["ms", "200"]],
      created_at: 1_700_000_013,
    });
    await guestbookSub.handler(lateJoin);

    expect(onMemberJoin).toHaveBeenCalledTimes(2);
    const lateCtx = onMemberJoin.mock.calls[1][0];
    expect(lateCtx.defaultChannelId).toBe(PUBLIC_CHANNEL);
    expect(lateCtx.defaultChannelName).toBe("general");
    await lateCtx.replyChannel(`Welcome nostr:${ nip19.npubEncode(secondMember) }!`);
    expect(currentHarness.published).toHaveLength(1);

    const publicGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(PUBLIC_CHANNEL, "hex"),
      2,
    );
    const decoded = decodeConcordStreamEvent(currentHarness.published[0], publicGroup, {
      channelId: PUBLIC_CHANNEL,
      epoch: 2,
      allowedKinds: [9],
    });
    expect(decoded?.rumor.content).toContain(nip19.npubEncode(secondMember));
  });

  it("isolates private channels in publishChannelMessage and waits for #general when folded asynchronously", async () => {
    const notificationsChannelId =
      "0daff3a90287ce6bef9a4f372aaa7b5689178ad5ec47c1647df22169b42cb314";
    await currentHarness.manager.acceptDirectInvite(
      directInviteRumor({
        ...bundle(),
        channels: [
          {
            id: notificationsChannelId,
            key: PRIVATE_KEY,
            epoch: 1,
            name: "Notifications",
          },
        ],
      }),
    );
    currentHarness.published.length = 0;

    // 1. Publishing to "general" when only private "Notifications" is active must NOT fall back to "Notifications"
    await expect(
      currentHarness.manager.publishChannelMessage(
        COMMUNITY_ID,
        "general",
        "Hello public",
        [],
        { waitTimeoutMs: 60 },
      ),
    ).rejects.toThrow("Concord channel is not active");
    expect(currentHarness.published).toHaveLength(0);

    // 2. Direct publish to private "Notifications" by channel ID or name succeeds
    await currentHarness.manager.publishChannelMessage(
      COMMUNITY_ID,
      notificationsChannelId,
      "🟢 New Subscription...",
    );
    await currentHarness.manager.publishChannelMessage(
      COMMUNITY_ID,
      "Notifications",
      "🟢 Renewal...",
    );
    expect(currentHarness.published).toHaveLength(2);
    const notificationsGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(notificationsChannelId, "hex"),
      1,
    );
    expect(
      decodeConcordStreamEvent(currentHarness.published[0], notificationsGroup, {
        channelId: notificationsChannelId,
        epoch: 1,
        allowedKinds: [9],
      })?.rumor.content,
    ).toBe("🟢 New Subscription...");
    expect(
      decodeConcordStreamEvent(currentHarness.published[1], notificationsGroup, {
        channelId: notificationsChannelId,
        epoch: 1,
        allowedKinds: [9],
      })?.rumor.content,
    ).toBe("🟢 Renewal...");

    currentHarness.published.length = 0;

    // 3. When "general" is folded asynchronously within the readiness window, publishChannelMessage waits and publishes to "general"
    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const controlGroup = {
      ...controlRead,
      secretKey: CONTROL_SIGNER_SECRET,
      publicKey: CONTROL_PK,
    };
    const controlSub = findSubscription(CONTROL_PK);
    setTimeout(() => {
      void controlSub.handler(
        createConcordStreamEvent(
          OWNER_SECRET,
          controlGroup,
          {
            kind: CONCORD_CONTROL_KIND,
            content: JSON.stringify({ name: "general", private: false }),
            tags: [["vsk", "2"], ["eid", PUBLIC_CHANNEL], ["ev", "1"]],
            created_at: 1_700_000_020,
          },
          { sealKind: 20014 },
        ),
      );
    }, 50);

    await currentHarness.manager.publishChannelMessage(
      COMMUNITY_ID,
      "general",
      "Hello public after fold",
      [],
      { waitTimeoutMs: 500 },
    );

    expect(currentHarness.published).toHaveLength(1);
    const publicGroup = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(ROOT, "hex"),
      Buffer.from(PUBLIC_CHANNEL, "hex"),
      2,
    );
    expect(
      decodeConcordStreamEvent(currentHarness.published[0], publicGroup, {
        channelId: PUBLIC_CHANNEL,
        epoch: 2,
        allowedKinds: [9],
      })?.rumor.content,
    ).toBe("Hello public after fold");
  });

  it("merges new private channels, rotates channel/root epochs on direct re-invite, and ignores stale root_epoch invites", async () => {
    const notificationsChannelId =
      "0daff3a90287ce6bef9a4f372aaa7b5689178ad5ec47c1647df22169b42cb314";
    const initialBundle: ConcordInviteBundle = {
      ...bundle(),
      root_epoch: 1,
      channels: [],
    };
    await currentHarness.manager.acceptDirectInvite({
      ...directInviteRumor(initialBundle),
      id: "10".repeat(32),
    });
    expect(currentHarness.persistedCommunities[0]?.bundle.channels).toEqual([]);

    // Re-invite adding private "Notifications" channel
    const inviteWithNotifications: ConcordInviteBundle = {
      ...initialBundle,
      channels: [
        {
          id: notificationsChannelId,
          key: PRIVATE_KEY,
          epoch: 1,
          name: "Notifications",
        },
      ],
    };
    await currentHarness.manager.acceptDirectInvite({
      ...directInviteRumor(inviteWithNotifications),
      id: "11".repeat(32),
    });

    const epoch1Group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(PRIVATE_KEY, "hex"),
      Buffer.from(notificationsChannelId, "hex"),
      1,
    );
    const epoch1Sub = findSubscription(epoch1Group.publicKey);
    expect(epoch1Sub).toBeDefined();
    expect(currentHarness.persistedCommunities[0]?.bundle.channels).toEqual([
      {
        id: notificationsChannelId,
        key: PRIVATE_KEY,
        epoch: 1,
        name: "Notifications",
      },
    ]);

    // Subsequent re-invite rotating channel epoch (1 -> 2), key, and root_epoch (1 -> 2)
    const rotatedKey = "66".repeat(32);
    const rotatedRoot = "88".repeat(32);
    const rotatedInvite: ConcordInviteBundle = {
      ...inviteWithNotifications,
      community_root: rotatedRoot,
      root_epoch: 2,
      relays: [...RELAYS, "wss://relay2.community.example"],
      channels: [
        {
          id: notificationsChannelId,
          key: rotatedKey,
          epoch: 2,
          name: "Notifications",
        },
      ],
    };
    await currentHarness.manager.acceptDirectInvite({
      ...directInviteRumor(rotatedInvite),
      id: "12".repeat(32),
    });

    expect(epoch1Sub.disposed).toBe(true);
    const epoch2Group = deriveConcordGroupKey(
      "concord/channel",
      Buffer.from(rotatedKey, "hex"),
      Buffer.from(notificationsChannelId, "hex"),
      2,
    );
    expect(findSubscription(epoch2Group.publicKey)).toBeDefined();
    expect(currentHarness.persistedCommunities[0]?.bundle).toEqual(
      expect.objectContaining({
        community_root: rotatedRoot,
        root_epoch: 2,
        relays: ["wss://community.example", "wss://relay2.community.example"],
        channels: [
          {
            id: notificationsChannelId,
            key: rotatedKey,
            epoch: 2,
            name: "Notifications",
          },
        ],
      }),
    );

    currentHarness.published.length = 0;
    await currentHarness.manager.publishChannelMessage(
      COMMUNITY_ID,
      notificationsChannelId,
      "Rotated key notification",
    );
    expect(currentHarness.published).toHaveLength(1);
    expect(
      decodeConcordStreamEvent(currentHarness.published[0], epoch2Group, {
        channelId: notificationsChannelId,
        epoch: 2,
        allowedKinds: [9],
      })?.rumor.content,
    ).toBe("Rotated key notification");

    // Stale invite with root_epoch < existing.bundle.root_epoch is ignored
    const staleInvite: ConcordInviteBundle = {
      ...initialBundle,
      root_epoch: 1,
      channels: [
        {
          id: notificationsChannelId,
          key: PRIVATE_KEY,
          epoch: 1,
          name: "Notifications",
        },
      ],
    };
    await currentHarness.manager.acceptDirectInvite({
      ...directInviteRumor(staleInvite),
      id: "13".repeat(32),
    });
    expect(currentHarness.persistedCommunities[0]?.bundle.root_epoch).toBe(2);
    expect(currentHarness.persistedCommunities[0]?.bundle.channels[0]?.epoch).toBe(2);
    expect(currentHarness.persistedCommunities[0]?.bundle.channels[0]?.key).toBe(
      rotatedKey,
    );
  });

  it("rejects Kind 3313 direct invites and private channel key rotations from unauthorized senders while allowing owner, folded admins, and allowedInviterPubkeys", async () => {
    const notificationsChannelId =
      "0daff3a90287ce6bef9a4f372aaa7b5689178ad5ec47c1647df22169b42cb314";
    const attackerSecret = generateSecretKey();
    const attackerPubkey = getPublicKey(attackerSecret);
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const externalAdminSecret = generateSecretKey();
    const externalAdminPubkey = getPublicKey(externalAdminSecret);

    const manager = new ConcordCommunityManager({
      secretKey: BOT_SECRET,
      pubkey: BOT,
      relayTransport: currentHarness.transport,
      processMessage: currentHarness.processMessage,
      isFreshEvent: currentHarness.isFreshEvent,
      sendDirectMessage: currentHarness.sendDirectMessage,
      allowedInviterPubkeys: [nip19.npubEncode(externalAdminPubkey)],
      allowedCommunityIds: [COMMUNITY_ID],
      store: {
        loadCommunities: () => [...currentHarness.persistedCommunities],
        saveCommunity: (community) => {
          const idx = currentHarness.persistedCommunities.findIndex(
            (item) => item.bundle.community_id === community.bundle.community_id,
          );
          if (idx >= 0) {
            currentHarness.persistedCommunities[idx] = community;
          } else {
            currentHarness.persistedCommunities.push(community);
          }
        },
      },
      now: () => 1_700_000_000_123,
    });

    // 1. Initial invite forged by an unprivileged member/attacker (using real owner + owner_salt in payload) is rejected
    await manager.acceptDirectInvite({
      ...directInviteRumor(),
      id: "20".repeat(32),
      pubkey: attackerPubkey,
    });
    expect(currentHarness.persistedCommunities).toHaveLength(0);

    // 2. Initial invite signed by community owner succeeds
    await manager.acceptDirectInvite({
      ...directInviteRumor(),
      id: "21".repeat(32),
      pubkey: OWNER,
    });
    expect(currentHarness.persistedCommunities).toHaveLength(1);

    // 3. Attacker (regular community member) attempts to inject/hijack private Notifications channel key (epoch 99) -> rejected
    const hijackedKey = "99".repeat(32);
    const hijackAttempt: ConcordInviteBundle = {
      ...bundle(),
      channels: [
        {
          id: notificationsChannelId,
          key: hijackedKey,
          epoch: 99,
          name: "Notifications",
        },
      ],
    };
    await manager.acceptDirectInvite({
      ...directInviteRumor(hijackAttempt),
      id: "22".repeat(32),
      pubkey: attackerPubkey,
    });
    expect(
      currentHarness.persistedCommunities[0]?.bundle.channels.find(
        (c) => c.id === notificationsChannelId,
      ),
    ).toBeUndefined();

    // 4. Invite signed by allow-listed npub in allowedInviterPubkeys succeeds
    const validNotificationsInvite: ConcordInviteBundle = {
      ...bundle(),
      channels: [
        {
          id: notificationsChannelId,
          key: PRIVATE_KEY,
          epoch: 1,
          name: "Notifications",
        },
      ],
    };
    await manager.acceptDirectInvite({
      ...directInviteRumor(validNotificationsInvite),
      id: "23".repeat(32),
      pubkey: externalAdminPubkey,
    });
    expect(
      currentHarness.persistedCommunities[0]?.bundle.channels.find(
        (c) => c.id === notificationsChannelId,
      ),
    ).toEqual({
      id: notificationsChannelId,
      key: PRIVATE_KEY,
      epoch: 1,
      name: "Notifications",
    });

    // 5. Grant server-level Admin role to adminPubkey via Control stream, then rotate channel key via adminPubkey -> succeeds
    const controlRead = deriveConcordGroupKey(
      "concord/control",
      Buffer.from(ROOT, "hex"),
      Buffer.from(COMMUNITY_ID, "hex"),
      2,
    );
    const controlGroup = {
      ...controlRead,
      secretKey: CONTROL_SIGNER_SECRET,
      publicKey: CONTROL_PK,
    };
    const adminRoleId = "85".repeat(32);
    const controlSub = findSubscription(CONTROL_PK);
    await controlSub.handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({
            role_id: adminRoleId,
            name: "Admin",
            position: 1,
            permissions: "0",
            scope: { kind: "server" },
          }),
          tags: [["vsk", "1"], ["eid", adminRoleId], ["ev", "1"]],
          created_at: 1_700_000_000,
        },
        { sealKind: 20014 },
      ),
    );
    await controlSub.handler(
      createConcordStreamEvent(
        OWNER_SECRET,
        controlGroup,
        {
          kind: CONCORD_CONTROL_KIND,
          content: JSON.stringify({ member: adminPubkey, role_ids: [adminRoleId] }),
          tags: [
            ["vsk", "3"],
            ["eid", computeConcordGrantLocator(COMMUNITY_ID, adminPubkey)],
            ["ev", "1"],
          ],
          created_at: 1_700_000_001,
        },
        { sealKind: 20014 },
      ),
    );

    const rotatedByFoldedAdminKey = "77".repeat(32);
    await manager.acceptDirectInvite({
      ...directInviteRumor({
        ...bundle(),
        channels: [
          {
            id: notificationsChannelId,
            key: rotatedByFoldedAdminKey,
            epoch: 2,
            name: "Notifications",
          },
        ],
      }),
      id: "24".repeat(32),
      pubkey: adminPubkey,
    });
    expect(
      currentHarness.persistedCommunities[0]?.bundle.channels.find(
        (c) => c.id === notificationsChannelId,
      ),
    ).toEqual({
      id: notificationsChannelId,
      key: rotatedByFoldedAdminKey,
      epoch: 2,
      name: "Notifications",
    });
  });

  it("enforces allowedCommunityIds on both acceptDirectInvite and restoreCommunities", async () => {
    const foreignOwnerSecret = generateSecretKey();
    const foreignOwner = getPublicKey(foreignOwnerSecret);
    const foreignSalt = "ab".repeat(32);
    const foreignCommunityId = computeConcordCommunityId(foreignOwner, foreignSalt);
    const foreignBundle: ConcordInviteBundle = {
      ...bundle(),
      community_id: foreignCommunityId,
      owner: foreignOwner,
      owner_salt: foreignSalt,
    };

    currentHarness.persistedCommunities.push({
      bundle: foreignBundle,
      joinPublished: true,
    });

    const restrictedManager = new ConcordCommunityManager({
      secretKey: BOT_SECRET,
      pubkey: BOT,
      relayTransport: currentHarness.transport,
      processMessage: currentHarness.processMessage,
      isFreshEvent: currentHarness.isFreshEvent,
      sendDirectMessage: currentHarness.sendDirectMessage,
      allowedCommunityIds: [COMMUNITY_ID],
      store: {
        loadCommunities: () => [...currentHarness.persistedCommunities],
        saveCommunity: (community) => {
          currentHarness.persistedCommunities.push(community);
        },
      },
      now: () => 1_700_000_000_123,
    });

    // Foreign persisted community is skipped on restoreCommunities
    await restrictedManager.restoreCommunities();
    expect(currentHarness.addRelays).not.toHaveBeenCalled();

    // Direct invite for foreign community (even signed by foreignOwner) is rejected
    await restrictedManager.acceptDirectInvite({
      ...directInviteRumor(foreignBundle),
      id: "30".repeat(32),
      pubkey: foreignOwner,
    });
    expect(currentHarness.addRelays).not.toHaveBeenCalled();

    // Direct invite for allow-listed COMMUNITY_ID signed by OWNER is accepted
    await restrictedManager.acceptDirectInvite({
      ...directInviteRumor(bundle()),
      id: "31".repeat(32),
      pubkey: OWNER,
    });
    expect(currentHarness.addRelays).toHaveBeenCalledWith(RELAYS);
  });

  it("restores persisted communities before processing early relay-replayed invites on startup", async () => {
    const notificationsChannelId = "0daff3a90287ce6bef9a4f372aaa7b5689178ad5ec47c1647df22169b42cb314";
    const notificationsChannelKey = "99".repeat(32);
    const persistedBundle: ConcordInviteBundle = {
      ...bundle(),
      channels: [
        {
          id: notificationsChannelId,
          key: notificationsChannelKey,
          epoch: 1,
          name: "Notifications",
        },
      ],
    };

    const stored: PersistedConcordCommunity[] = [
      {
        bundle: persistedBundle,
        joinPublished: true,
      },
    ];
    const saveCommunitySpy = vi.fn((updated: PersistedConcordCommunity) => {
      const idx = stored.findIndex(
        (entry) => entry.bundle.community_id === updated.bundle.community_id,
      );
      if (idx >= 0) {
        stored[idx] = updated;
      } else {
        stored.push(updated);
      }
    });

    const startupManager = new ConcordCommunityManager({
      secretKey: BOT_SECRET,
      pubkey: BOT,
      relayTransport: currentHarness.transport,
      processMessage: currentHarness.processMessage,
      isFreshEvent: currentHarness.isFreshEvent,
      sendDirectMessage: currentHarness.sendDirectMessage,
      store: {
        loadCommunities: () => stored.map((entry) => structuredClone(entry)),
        saveCommunity: saveCommunitySpy,
      },
      now: () => 1_700_000_000_123,
    });

    // Simulate a fast relay replaying an older 0-channel community invite
    // during relayConnections.start() before restoreCommunities() is called.
    const emptyInviteBundle: ConcordInviteBundle = {
      ...bundle(),
      channels: [],
    };
    const replayAccepted = await startupManager.acceptDirectInvite({
      ...directInviteRumor(emptyInviteBundle),
      id: "08".repeat(32),
      pubkey: OWNER,
    });
    expect(replayAccepted).toBe(false);

    await startupManager.restoreCommunities();

    // Must not re-publish Kind 3306 Join or overwrite stored private channels with []
    expect(currentHarness.publishToRelays).not.toHaveBeenCalled();
    expect(saveCommunitySpy).not.toHaveBeenCalled();
    expect(stored[0]?.bundle.channels).toEqual([
      {
        id: notificationsChannelId,
        key: notificationsChannelKey,
        epoch: 1,
        name: "Notifications",
      },
    ]);

    await startupManager.publishChannelMessage(
      COMMUNITY_ID,
      notificationsChannelId,
      "Private notification after restart",
    );
    expect(currentHarness.publishToRelays).toHaveBeenCalledTimes(1);
  });
});

