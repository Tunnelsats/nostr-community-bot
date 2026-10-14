import { isIP } from "node:net";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { nip19, nip44 } from "nostr-tools";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
  type NostrEvent,
  type UnsignedEvent,
} from "nostr-tools/pure";
import { isPublicIpAddress } from "./dm-relays.js";

export const CONCORD_MANAGE_ROLES = 1n << 0n;
export const CONCORD_MANAGE_CHANNELS = 1n << 1n;
export const CONCORD_MANAGE_MESSAGES = 1n << 5n;

export const CONCORD_STREAM_KIND = 1059;
export const CONCORD_EPHEMERAL_STREAM_KIND = 21059;
export const CONCORD_DIRECT_INVITE_KIND = 3313;
export const CONCORD_JOIN_KIND = 3306;
export const CONCORD_CONTROL_KIND = 3308;

const ENCRYPTED_SEAL_KIND = 20013;
const PLAINTEXT_SEAL_KIND = 20014;
const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ZERO_ID = new Uint8Array(32);
const MAX_CIPHERTEXT_LENGTH = 256 * 1024;
const MAX_RUMOR_CONTENT_LENGTH = 16 * 1024;
const MAX_TAGS = 64;
const MAX_TAG_PARTS = 8;
const MAX_TAG_PART_LENGTH = 2_048;
const MAX_INVITE_CHANNELS = 256;
const MAX_INVITE_RELAYS = 5;
const MAX_RELAY_LENGTH = 512;
const MAX_TEXT_LENGTH = 256;
const ROLELESS_POSITION = 0xffffffff;
const MAX_ROLES = 100;
const MAX_ROLES_PER_MEMBER = 64;

export interface ConcordGroupKey {
  secretKey: Uint8Array;
  publicKey: string;
  conversationKey: Uint8Array;
}

export interface ConcordInviteChannel {
  id: string;
  key: string;
  epoch: number;
  name?: string;
}

export interface ConcordInviteBundle {
  community_id: string;
  owner: string;
  owner_salt: string;
  community_root: string;
  root_epoch: number;
  control_pk: string;
  channels: ConcordInviteChannel[];
  relays: string[];
  name: string;
  expires_at?: number;
  creator_npub?: string;
  label?: string;
}

export interface ConcordRumor extends UnsignedEvent {
  id: string;
}

export interface DecodedConcordEvent {
  rumor: ConcordRumor;
  author: string;
  wrapId: string;
}

export interface ConcordControlEdition {
  author: string;
  rumorId: string;
  vsk: number;
  eid: string;
  version: number;
  prev?: string;
  content: string;
}

interface ConcordRole {
  role_id: string;
  name: string;
  position: number;
  permissions: bigint;
  deleted: boolean;
  scope: { kind: "server" } | { kind: "channel"; channel_id: string };
}

interface ConcordStanding {
  isOwner: boolean;
  position: number;
  permissions: bigint;
}

export interface ConcordChannelDefinition {
  channelId: string;
  name: string;
  private: boolean;
  deleted: boolean;
}

export type ConcordRoleType = "owner" | "admin" | "moderator" | "member";

export interface FoldedConcordControl {
  channels: ConcordChannelDefinition[];
  canManageMessages(actor: string, target: string, channelId: string): boolean;
  canManageChannelOrMessages(actor: string, channelId: string): boolean;
  roleFor(actor: string, channelId?: string): ConcordRoleType;
  roleIdsFor(member: string): string[];
}

interface StreamTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

interface DecodeOptions {
  allowedKinds: number[];
  channelId?: string;
  epoch?: number;
  sealKind?: typeof ENCRYPTED_SEAL_KIND | typeof PLAINTEXT_SEAL_KIND;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedText(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length <= max;
}

function isBoundedUtf8(value: unknown, max: number): value is string {
  return typeof value === "string" && utf8ToBytes(value).length <= max;
}

function isTags(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TAGS &&
    value.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length <= MAX_TAG_PARTS &&
        tag.every((part) => typeof part === "string" && part.length <= MAX_TAG_PART_LENGTH),
    )
  );
}

function isSignedEvent(value: unknown): value is NostrEvent {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.kind) &&
    isSafeInteger(value.created_at) &&
    typeof value.content === "string" &&
    isTags(value.tags) &&
    typeof value.pubkey === "string" &&
    HEX_KEY.test(value.pubkey) &&
    typeof value.id === "string" &&
    HEX_KEY.test(value.id) &&
    typeof value.sig === "string" &&
    HEX_SIGNATURE.test(value.sig)
  );
}

function isRumor(value: unknown): value is ConcordRumor {
  if (!isRecord(value) || Object.hasOwn(value, "sig")) return false;
  return (
    Number.isInteger(value.kind) &&
    isSafeInteger(value.created_at) &&
    isBoundedUtf8(value.content, MAX_RUMOR_CONTENT_LENGTH) &&
    isTags(value.tags) &&
    typeof value.pubkey === "string" &&
    HEX_KEY.test(value.pubkey) &&
    typeof value.id === "string" &&
    HEX_KEY.test(value.id)
  );
}

function bigEndianEpoch(epoch: number): Uint8Array {
  if (!isSafeInteger(epoch)) throw new Error("Invalid Concord epoch");
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, BigInt(epoch));
  return encoded;
}

function lengthPrefix(value: Uint8Array): Uint8Array {
  const prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setBigUint64(0, BigInt(value.length));
  return concatBytes(prefix, value);
}

function bytesToScalar(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function concordHkdf(
  secret: Uint8Array,
  label: string,
  id: Uint8Array = ZERO_ID,
  epoch?: number,
  counter?: number,
): Uint8Array {
  if (secret.length !== 32 || id.length !== 32) throw new Error("Invalid Concord key input");
  const info = [utf8ToBytes(label), new Uint8Array([0]), id];
  if (epoch !== undefined) info.push(bigEndianEpoch(epoch));
  if (counter !== undefined) info.push(new Uint8Array([counter]));
  return hkdf(sha256, secret, new Uint8Array(0), concatBytes(...info), 32);
}

function normalizeScalar(
  secret: Uint8Array,
  label: string,
  id: Uint8Array,
  epoch: number | undefined,
): Uint8Array {
  const initial = concordHkdf(secret, label, id, epoch);
  const scalar = bytesToScalar(initial);
  if (scalar > 0n && scalar < SECP256K1_ORDER) return initial;
  for (let counter = 0; counter < 256; counter += 1) {
    const candidate = concordHkdf(secret, label, id, epoch, counter);
    const value = bytesToScalar(candidate);
    if (value > 0n && value < SECP256K1_ORDER) return candidate;
  }
  throw new Error("Concord scalar normalization failed");
}

export function deriveConcordGroupKey(
  label: string,
  secret: Uint8Array,
  id: Uint8Array = ZERO_ID,
  epoch?: number,
): ConcordGroupKey {
  const secretKey = normalizeScalar(secret, label, id, epoch);
  const publicKey = getPublicKey(secretKey);
  return {
    secretKey,
    publicKey,
    conversationKey: nip44.v2.utils.getConversationKey(secretKey, publicKey),
  };
}

export function computeConcordCommunityId(owner: string, ownerSalt: string): string {
  if (!HEX_KEY.test(owner) || !HEX_KEY.test(ownerSalt)) throw new Error("Invalid Concord owner");
  return bytesToHex(
    sha256(concatBytes(utf8ToBytes("concord/community"), hexToBytes(owner), hexToBytes(ownerSalt))),
  );
}

export function computeConcordGrantLocator(communityId: string, member: string): string {
  if (!HEX_KEY.test(communityId) || !HEX_KEY.test(member)) {
    throw new Error("Invalid Concord grant coordinate");
  }
  return bytesToHex(
    concordHkdf(hexToBytes(communityId), "concord/grant", hexToBytes(member)),
  );
}

export function computeConcordEditionHash(edition: ConcordControlEdition): string {
  if (
    !HEX_KEY.test(edition.eid) ||
    !Number.isSafeInteger(edition.version) ||
    edition.version < 1 ||
    (edition.prev !== undefined && !HEX_KEY.test(edition.prev)) ||
    typeof edition.content !== "string"
  ) {
    throw new Error("Invalid Concord edition");
  }
  const previous = edition.prev ? hexToBytes(edition.prev) : ZERO_ID;
  return bytesToHex(
    sha256(
      concatBytes(
        lengthPrefix(utf8ToBytes("vector-community/v1/edition")),
        hexToBytes(edition.eid),
        bigEndianEpoch(edition.version),
        new Uint8Array([edition.prev ? 1 : 0]),
        previous,
        lengthPrefix(utf8ToBytes(edition.content)),
      ),
    ),
  );
}

function isSafeRelay(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RELAY_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "wss:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.hostname.length > 0 &&
      (isIP(hostname) === 0 || isPublicIpAddress(hostname))
    );
  } catch {
    return false;
  }
}

function validateInviteChannel(value: unknown): ConcordInviteChannel | null {
  if (!isRecord(value) || !HEX_KEY.test(String(value.id)) || !HEX_KEY.test(String(value.key))) {
    return null;
  }
  if (!isSafeInteger(value.epoch)) return null;
  if (value.name !== undefined && !isBoundedText(value.name)) return null;
  return {
    id: value.id as string,
    key: value.key as string,
    epoch: value.epoch,
    ...(value.name !== undefined ? { name: value.name as string } : {}),
  };
}

export function validateConcordInvite(
  value: unknown,
  nowMs = Date.now(),
): ConcordInviteBundle | null {
  if (!isRecord(value)) {
    console.debug("[Concord] Direct invite validation failed: payload is not an object");
    return null;
  }
  const requiredKeys = [
    value.community_id,
    value.owner,
    value.owner_salt,
    value.community_root,
  ];
  if (!requiredKeys.every((key) => typeof key === "string" && HEX_KEY.test(key))) {
    console.debug("[Concord] Direct invite validation failed: required hex keys missing or invalid");
    return null;
  }
  if (!isSafeInteger(value.root_epoch)) {
    console.debug("[Concord] Direct invite validation failed: root_epoch is not a safe integer");
    return null;
  }
  if (value.name !== undefined && !isBoundedText(value.name)) {
    console.debug("[Concord] Direct invite validation failed: name exceeds bounds");
    return null;
  }
  if (
    computeConcordCommunityId(value.owner as string, value.owner_salt as string) !==
    value.community_id
  ) {
    console.debug("[Concord] Direct invite validation failed: owner/salt does not reproduce community_id");
    return null;
  }
  let controlPk = value.control_pk;
  if (controlPk === undefined) {
    try {
      controlPk = deriveConcordGroupKey(
        "concord/control",
        Buffer.from(value.community_root as string, "hex"),
        Buffer.from(value.community_id as string, "hex"),
        value.root_epoch as number,
      ).publicKey;
    } catch {
      console.debug("[Concord] Direct invite validation failed: unable to derive control_pk");
      return null;
    }
  }
  if (typeof controlPk !== "string" || !HEX_KEY.test(controlPk)) {
    console.debug("[Concord] Direct invite validation failed: control_pk is invalid hex");
    return null;
  }
  if (
    !Array.isArray(value.channels) ||
    value.channels.length > MAX_INVITE_CHANNELS ||
    !Array.isArray(value.relays) ||
    value.relays.length === 0 ||
    value.relays.length > MAX_INVITE_RELAYS
  ) {
    console.debug("[Concord] Direct invite validation failed: invalid channels or relays length");
    return null;
  }
  const channels = value.channels.map(validateInviteChannel);
  if (channels.some((channel) => channel === null)) {
    console.debug("[Concord] Direct invite validation failed: one or more channels failed validation");
    return null;
  }
  const channelIds = channels.map((channel) => (channel as ConcordInviteChannel).id);
  if (new Set(channelIds).size !== channelIds.length) {
    console.debug("[Concord] Direct invite validation failed: duplicate channel ids");
    return null;
  }
  if (!value.relays.every(isSafeRelay)) {
    console.debug("[Concord] Direct invite validation failed: one or more relays are unsafe or non-wss");
    return null;
  }
  const relays = [...new Set(value.relays as string[])];
  if (value.expires_at !== undefined) {
    if (!isSafeInteger(value.expires_at)) {
      console.debug("[Concord] Direct invite validation failed: expires_at is not a safe integer");
      return null;
    }
    const expiryMs = value.expires_at < 1_000_000_000_000 ? value.expires_at * 1_000 : value.expires_at;
    if (expiryMs < nowMs) {
      console.debug("[Concord] Direct invite validation failed: invite has expired");
      return null;
    }
  }
  if (value.creator_npub !== undefined) {
    if (typeof value.creator_npub !== "string") {
      console.debug("[Concord] Direct invite validation failed: creator_npub is invalid");
      return null;
    }
    if (!HEX_KEY.test(value.creator_npub)) {
      try {
        const decoded = nip19.decode(value.creator_npub);
        if (decoded.type !== "npub" || !HEX_KEY.test(decoded.data)) {
          throw new Error("Invalid npub");
        }
      } catch {
        console.debug("[Concord] Direct invite validation failed: creator_npub is invalid");
        return null;
      }
    }
  }
  if (value.label !== undefined && !isBoundedText(value.label)) {
    console.debug("[Concord] Direct invite validation failed: label exceeds bounds");
    return null;
  }
  return {
    community_id: value.community_id as string,
    owner: value.owner as string,
    owner_salt: value.owner_salt as string,
    community_root: value.community_root as string,
    root_epoch: value.root_epoch as number,
    control_pk: controlPk as string,
    channels: channels as ConcordInviteChannel[],
    relays,
    name: value.name ?? "",
    ...(value.expires_at !== undefined ? { expires_at: value.expires_at as number } : {}),
    ...(value.creator_npub !== undefined ? { creator_npub: value.creator_npub as string } : {}),
    ...(value.label !== undefined ? { label: value.label as string } : {}),
  };
}

function createRumor(authorSecret: Uint8Array, template: StreamTemplate): ConcordRumor {
  if (
    authorSecret.length !== 32 ||
    !Number.isInteger(template.kind) ||
    !isSafeInteger(template.created_at) ||
    !isBoundedUtf8(template.content, MAX_RUMOR_CONTENT_LENGTH) ||
    !isTags(template.tags)
  ) {
    throw new Error("Invalid Concord rumor");
  }
  const unsigned: UnsignedEvent = {
    kind: template.kind,
    pubkey: getPublicKey(authorSecret),
    content: template.content,
    tags: template.tags.map((tag) => [...tag]),
    created_at: template.created_at,
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}

export function createConcordStreamEvent(
  authorSecret: Uint8Array,
  group: ConcordGroupKey,
  template: StreamTemplate,
  options: { ephemeral?: boolean; sealKind?: typeof ENCRYPTED_SEAL_KIND | typeof PLAINTEXT_SEAL_KIND } = {},
): NostrEvent {
  if (group.secretKey.length !== 32 || !HEX_KEY.test(group.publicKey)) {
    throw new Error("Invalid Concord group key");
  }
  const rumor = createRumor(authorSecret, template);
  const sealKind = options.sealKind ?? ENCRYPTED_SEAL_KIND;
  const rumorJson = JSON.stringify(rumor);
  const seal = finalizeEvent(
    {
      kind: sealKind,
      content:
        sealKind === PLAINTEXT_SEAL_KIND
          ? rumorJson
          : nip44.v2.encrypt(rumorJson, group.conversationKey),
      tags: [],
      created_at: template.created_at,
    },
    authorSecret,
  );
  const decoyPubkey = getPublicKey(generateSecretKey());
  const event = finalizeEvent(
    {
      kind: options.ephemeral ? CONCORD_EPHEMERAL_STREAM_KIND : CONCORD_STREAM_KIND,
      content: nip44.v2.encrypt(JSON.stringify(seal), group.conversationKey),
      tags: [["p", decoyPubkey]],
      created_at: template.created_at,
    },
    group.secretKey,
  );
  if (event.content.length > MAX_CIPHERTEXT_LENGTH) throw new Error("Concord output too large");
  return event;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function hasBinding(tags: string[][], channelId: string, epoch: number): boolean {
  const channels = tags.filter((tag) => tag[0] === "channel");
  const epochs = tags.filter((tag) => tag[0] === "epoch");
  if (channels.length !== 1 || epochs.length !== 1) return false;
  return channels[0][1] === channelId && epochs[0][1] === String(epoch);
}

function hasValidStreamWrapTags(tags: string[][]): boolean {
  const recipients = tags.filter((tag) => tag[0] === "p");
  const expirations = tags.filter((tag) => tag[0] === "expiration");
  if (
    recipients.length !== 1 ||
    recipients[0].length !== 2 ||
    !HEX_KEY.test(recipients[0][1] ?? "") ||
    expirations.length > 1
  ) {
    return false;
  }
  if (
    expirations.length === 1 &&
    (expirations[0].length !== 2 || !/^[1-9][0-9]*$/.test(expirations[0][1] ?? ""))
  ) {
    return false;
  }
  return tags.every((tag) => tag[0] === "p" || tag[0] === "expiration");
}

export function decodeConcordStreamEvent(
  wrap: NostrEvent,
  group: ConcordGroupKey,
  options: DecodeOptions,
): DecodedConcordEvent | null {
  try {
    if (
      !isSignedEvent(wrap) ||
      (wrap.kind !== CONCORD_STREAM_KIND && wrap.kind !== CONCORD_EPHEMERAL_STREAM_KIND) ||
      wrap.pubkey !== group.publicKey ||
      wrap.content.length > MAX_CIPHERTEXT_LENGTH ||
      !hasValidStreamWrapTags(wrap.tags) ||
      !verifyEvent(wrap)
    ) {
      return null;
    }
    const sealValue = parseJson(nip44.v2.decrypt(wrap.content, group.conversationKey));
    if (
      !isSignedEvent(sealValue) ||
      (sealValue.kind !== ENCRYPTED_SEAL_KIND && sealValue.kind !== PLAINTEXT_SEAL_KIND) ||
      (options.sealKind !== undefined && sealValue.kind !== options.sealKind) ||
      sealValue.tags.length !== 0 ||
      !verifyEvent(sealValue)
    ) {
      return null;
    }
    const rumorJson =
      sealValue.kind === PLAINTEXT_SEAL_KIND
        ? sealValue.content
        : nip44.v2.decrypt(sealValue.content, group.conversationKey);
    const rumorValue = parseJson(rumorJson);
    if (
      !isRumor(rumorValue) ||
      rumorValue.pubkey !== sealValue.pubkey ||
      rumorValue.id !== getEventHash(rumorValue) ||
      !options.allowedKinds.includes(rumorValue.kind)
    ) {
      return null;
    }
    if (
      options.channelId !== undefined &&
      options.epoch !== undefined &&
      !hasBinding(rumorValue.tags, options.channelId, options.epoch)
    ) {
      return null;
    }
    const ms = rumorValue.tags.filter((tag) => tag[0] === "ms");
    if (
      ms.length > 1 ||
      (ms.length === 1 && !/^(?:[0-9]|[1-9][0-9]{1,2})$/.test(ms[0][1] ?? "")) ||
      (ms.length === 1 && Number(ms[0][1]) > 999)
    ) {
      return null;
    }
    return { rumor: rumorValue, author: sealValue.pubkey, wrapId: wrap.id };
  } catch {
    return null;
  }
}

function parseRole(edition: ConcordControlEdition): ConcordRole | null {
  const value = parseJson(edition.content);
  if (!isRecord(value) || value.role_id !== edition.eid || !isBoundedText(value.name, 64)) {
    return null;
  }
  if (value.deleted !== undefined && typeof value.deleted !== "boolean") return null;
  if (
    !Number.isInteger(value.position) ||
    (value.position as number) <= 0 ||
    (value.position as number) >= ROLELESS_POSITION
  ) {
    return null;
  }
  let permissions: bigint;
  try {
    permissions = BigInt(value.permissions as string | number);
  } catch {
    return null;
  }
  if (permissions < 0n || permissions > 0xffffffffffffffffn) return null;
  let scope: ConcordRole["scope"];
  if (isRecord(value.scope) && value.scope.kind === "channel" && HEX_KEY.test(String(value.scope.channel_id))) {
    scope = { kind: "channel", channel_id: value.scope.channel_id as string };
  } else if (value.scope === undefined || (isRecord(value.scope) && value.scope.kind === "server")) {
    scope = { kind: "server" };
  } else {
    return null;
  }
  return {
    role_id: edition.eid,
    name: value.name,
    position: value.position as number,
    permissions,
    deleted: value.deleted === true,
    scope,
  };
}

function groupCandidates(editions: ConcordControlEdition[], vsk: number): Map<string, ConcordControlEdition[]> {
  const unchecked = new Map<string, ConcordControlEdition[]>();
  for (const edition of editions) {
    if (
      edition.vsk !== vsk ||
      !HEX_KEY.test(edition.author) ||
      !HEX_KEY.test(edition.eid) ||
      !HEX_KEY.test(edition.rumorId) ||
      !Number.isSafeInteger(edition.version) ||
      edition.version < 1 ||
      (edition.prev !== undefined && !HEX_KEY.test(edition.prev)) ||
      utf8ToBytes(edition.content).length > MAX_RUMOR_CONTENT_LENGTH
    ) {
      continue;
    }
    const candidates = unchecked.get(edition.eid) ?? [];
    candidates.push(edition);
    unchecked.set(edition.eid, candidates);
  }
  const grouped = new Map<string, ConcordControlEdition[]>();
  for (const [eid, candidates] of unchecked) {
    const hasGenesis = candidates.some(
      (candidate) => candidate.version === 1 && candidate.prev === undefined,
    );
    const baselineVersion = hasGenesis
      ? 1
      : Math.max(...candidates.map((candidate) => candidate.version));
    let previous = candidates.filter(
      (candidate) =>
        candidate.version === baselineVersion &&
        (baselineVersion > 1 || candidate.prev === undefined),
    );
    const connected = [...previous];
    let version = baselineVersion + 1;
    while (previous.length > 0) {
      const expected = new Set(previous.map(computeConcordEditionHash));
      const next = candidates.filter(
        (candidate) => candidate.version === version && expected.has(candidate.prev ?? ""),
      );
      if (next.length === 0) break;
      connected.push(...next);
      previous = next;
      version += 1;
    }
    connected.sort(
      (left, right) => right.version - left.version || left.rumorId.localeCompare(right.rumorId),
    );
    if (connected.length > 0) grouped.set(eid, connected);
  }
  return grouped;
}

function applicable(role: ConcordRole, channelId: string): boolean {
  return role.scope.kind === "server" || role.scope.channel_id === channelId;
}

export function foldConcordControl(
  editions: ConcordControlEdition[],
  material: { communityId: string; owner: string },
): FoldedConcordControl {
  if (!HEX_KEY.test(material.communityId) || !HEX_KEY.test(material.owner)) {
    throw new Error("Invalid Concord control material");
  }
  const roleCandidates = groupCandidates(editions, 1);
  const allowedRoleIds = [...roleCandidates.keys()].sort().slice(0, MAX_ROLES);
  const grantCandidates = groupCandidates(editions, 3);
  const channelCandidates = groupCandidates(editions, 2);
  const roles = new Map<string, ConcordRole>();
  const grants = new Map<string, string[]>();

  const standing = (member: string, channelId = ""): ConcordStanding => {
    if (member === material.owner) {
      return { isOwner: true, position: 0, permissions: 0xffffffffffffffffn };
    }
    let position = ROLELESS_POSITION;
    let permissions = 0n;
    for (const roleId of grants.get(member) ?? []) {
      const role = roles.get(roleId);
      if (!role || role.deleted || !applicable(role, channelId)) continue;
      position = Math.min(position, role.position);
      permissions |= role.permissions;
    }
    return { isOwner: false, position, permissions };
  };

  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const roleId of allowedRoleIds) {
      for (const candidate of roleCandidates.get(roleId) ?? []) {
        const role = parseRole(candidate);
        if (!role) continue;
        const actor = standing(candidate.author, role.scope.kind === "channel" ? role.scope.channel_id : "");
        if (
          !actor.isOwner &&
          ((actor.permissions & CONCORD_MANAGE_ROLES) === 0n || role.position <= actor.position)
        ) {
          continue;
        }
        const previous = roles.get(roleId);
        if (JSON.stringify(previous, (_, value) => (typeof value === "bigint" ? value.toString() : value)) !==
            JSON.stringify(role, (_, value) => (typeof value === "bigint" ? value.toString() : value))) {
          roles.set(roleId, role);
          changed = true;
        }
        break;
      }
    }
    for (const [eid, candidates] of grantCandidates) {
      for (const candidate of candidates) {
        const value = parseJson(candidate.content);
        if (!isRecord(value) || !HEX_KEY.test(String(value.member))) continue;
        const member = value.member as string;
        if (computeConcordGrantLocator(material.communityId, member) !== eid) continue;
        if (
          !Array.isArray(value.role_ids) ||
          value.role_ids.length > MAX_ROLES_PER_MEMBER ||
          !value.role_ids.every((roleId) => typeof roleId === "string" && HEX_KEY.test(roleId))
        ) {
          continue;
        }
        const roleIds = value.role_ids as string[];
        const actor = standing(candidate.author);
        const target = standing(member);
        const authorized =
          actor.isOwner ||
          ((actor.permissions & CONCORD_MANAGE_ROLES) !== 0n &&
            (member === candidate.author || actor.position < target.position) &&
            roleIds.every((roleId) => {
              const role = roles.get(roleId);
              return role !== undefined && role.position > actor.position;
            }));
        if (!authorized) continue;
        const previous = grants.get(member) ?? [];
        if (previous.join(",") !== roleIds.join(",")) {
          grants.set(member, [...roleIds]);
          changed = true;
        }
        break;
      }
    }
    if (!changed) break;
  }

  const channels: ConcordChannelDefinition[] = [];
  for (const [channelId, candidates] of channelCandidates) {
    let selected: ConcordChannelDefinition | null = null;
    const versions = [...new Set(candidates.map((candidate) => candidate.version))].sort(
      (left, right) => left - right,
    );
    for (const version of versions) {
      const winner = candidates
        .filter((candidate) => candidate.version === version)
        .find((candidate) => {
          const actor = standing(candidate.author, channelId);
          if (!actor.isOwner && (actor.permissions & CONCORD_MANAGE_CHANNELS) === 0n) {
            return false;
          }
          const value = parseJson(candidate.content);
          return (
            isRecord(value) &&
            isBoundedText(value.name, 64) &&
            typeof value.private === "boolean" &&
            (value.deleted === undefined || typeof value.deleted === "boolean")
          );
        });
      if (!winner) continue;
      const value = parseJson(winner.content) as Record<string, unknown>;
      selected = {
        channelId,
        name: value.name as string,
        private: value.private as boolean,
        deleted: value.deleted === true,
      };
      if (selected.deleted) break;
    }
    if (selected) channels.push(selected);
  }

  const roleFor = (actor: string, channelId = ""): ConcordRoleType => {
    if (actor === material.owner) return "owner";
    let hasModerator = false;
    for (const roleId of grants.get(actor) ?? []) {
      const role = roles.get(roleId);
      if (!role || role.deleted || !applicable(role, channelId)) continue;
      const trimmedName = role.name.trim();
      if (
        /^admin(?:istrator)?s?$/i.test(trimmedName) ||
        (role.permissions & (CONCORD_MANAGE_ROLES | CONCORD_MANAGE_CHANNELS)) !== 0n
      ) {
        return "admin";
      }
      if (
        /^mod(?:erator)?s?$/i.test(trimmedName) ||
        (role.permissions & CONCORD_MANAGE_MESSAGES) !== 0n
      ) {
        hasModerator = true;
      }
    }
    return hasModerator ? "moderator" : "member";
  };

  return {
    channels,
    canManageMessages(actor, target, channelId) {
      const actorStanding = standing(actor, channelId);
      const targetStanding = standing(target, channelId);
      return (
        (actorStanding.isOwner ||
          (actorStanding.permissions & CONCORD_MANAGE_MESSAGES) !== 0n) &&
        actorStanding.position < targetStanding.position
      );
    },
    canManageChannelOrMessages(actor, channelId) {
      const role = roleFor(actor, channelId);
      return role === "owner" || role === "admin" || role === "moderator";
    },
    roleFor,
    roleIdsFor(member) {
      return [...(grants.get(member) ?? [])];
    },
  };
}

export function hasWireGuardLeak(content: string): boolean {
  if (!isBoundedUtf8(content, MAX_RUMOR_CONTENT_LENGTH)) return false;
  if (/^\s*\/(?:link|unlink)(?:\s+\S+)/i.test(content)) return true;
  const matches = content.matchAll(/(?:^|[^A-Za-z0-9+/=])([A-Za-z0-9+/]{43}=)(?=$|[^A-Za-z0-9+/=])/g);
  for (const match of matches) {
    const candidate = match[1];
    try {
      const decoded = Buffer.from(candidate, "base64");
      if (decoded.length === 32 && decoded.toString("base64") === candidate) return true;
    } catch {
      // Ignore malformed base64 and continue scanning the bounded message.
    }
  }
  return false;
}
