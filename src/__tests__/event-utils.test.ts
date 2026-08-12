import { describe, it, expect } from "vitest";
import { parseSecretKey, parseCommand } from "../event-utils.js";

describe("event-utils", () => {
  describe("parseSecretKey", () => {
    it("parses valid hex secret keys", () => {
      const hexKey = "a3c06ceaab7c2c3dfe3f0d8f6c36dbd1fe7bca59af71a78f9b24a23acf244d8e";
      const result = parseSecretKey(hexKey);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it("parses valid nsec bech32 secret keys", () => {
      const nsecKey = "nsec150qxe64t0skrml3lpk8kcdkm68l8hjje4ac60rumyj3r4neyfk8qtlv2jl";
      const result = parseSecretKey(nsecKey);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it("throws an error for invalid key formats", () => {
      expect(() => parseSecretKey("invalid-key")).toThrow("Invalid Nostr private key format");
    });
  });

  describe("parseCommand", () => {
    it("parses /ping command without args", () => {
      const res = parseCommand("/ping");
      expect(res).toEqual({ command: "ping", args: [] });
    });

    it("parses /ping command with args", () => {
      const res = parseCommand("/ping 03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f");
      expect(res).toEqual({
        command: "ping",
        args: ["03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f"],
      });
    });

    it("returns null for non-command messages", () => {
      expect(parseCommand("Hello world")).toBeNull();
    });
  });
});
