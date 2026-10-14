import type { LookupFunction } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createPublicLookup,
  isPublicIpAddress,
  validateDmRelayUrl,
} from "../dm-relays.js";

function lookupAddress(lookup: LookupFunction, hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: false }, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      if (typeof address !== "string") {
        reject(new Error("Expected one address"));
        return;
      }
      resolve(address);
    });
  });
}

describe("DM relay destination validation", () => {
  it("accepts public addresses and rejects non-global IPv4 and IPv6 ranges", () => {
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIpAddress("192.0.0.8")).toBe(false);
    expect(isPublicIpAddress("192.88.99.2")).toBe(false);
    expect(isPublicIpAddress("100::1")).toBe(false);
    expect(isPublicIpAddress("2001:2::1")).toBe(false);
    expect(isPublicIpAddress("2002::1")).toBe(false);
    expect(isPublicIpAddress("2001:db8::1")).toBe(false);
    expect(isPublicIpAddress("3fff::1")).toBe(false);
    expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
  });

  it("rejects a hostname when any resolved address is not public", async () => {
    await expect(
      validateDmRelayUrl("wss://relay.example", async () => [
        "93.184.216.34",
        "127.0.0.1",
      ]),
    ).resolves.toBeNull();
  });

  it("pins the socket lookup to a public address returned by the checked resolver", async () => {
    const lookup = createPublicLookup(async () => ["93.184.216.34"]);

    await expect(lookupAddress(lookup, "relay.example")).resolves.toBe(
      "93.184.216.34",
    );
  });

  it("rejects DNS rebinding at the socket lookup boundary", async () => {
    const lookup = createPublicLookup(async () => ["127.0.0.1"]);

    await expect(lookupAddress(lookup, "relay.example")).rejects.toThrow(
      "public IP address",
    );
  });

  it("times out a stalled socket DNS lookup", async () => {
    const lookup = createPublicLookup(
      () => new Promise<string[]>(() => undefined),
      10,
    );

    await expect(lookupAddress(lookup, "relay.example")).rejects.toThrow(
      "timed out",
    );
  });
});
