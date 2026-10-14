import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";

const MAX_RELAY_URL_LENGTH = 2_048;
const DNS_LOOKUP_TIMEOUT_MS = 2_000;

const nonPublicIpv4Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
const nonPublicIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export type HostnameResolver = (hostname: string) => Promise<string[]>;

export const resolveHostname: HostnameResolver = async (hostname) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("DNS lookup timed out")),
          DNS_LOOKUP_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
    return addresses.map((entry) => entry.address);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

function isPublicIpv4(address: string): boolean {
  return !nonPublicIpv4Addresses.check(address, "ipv4");
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  return (
    /^[23]/.test(normalized) &&
    !nonPublicIpv6Addresses.check(normalized, "ipv6")
  );
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  const version = isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version === 6) return isPublicIpv6(normalized);
  return false;
}

function lookupError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Creates the DNS callback used by the actual TLS socket. The callback returns
 * only a checked address, so a later operating-system lookup cannot rebind the
 * hostname to a private destination between validation and connection.
 */
export function createPublicLookup(
  resolver: HostnameResolver = resolveHostname,
  timeoutMs = DNS_LOOKUP_TIMEOUT_MS,
): LookupFunction {
  return (hostname, options, callback) => {
    let settled = false;
    const finish = (
      error: NodeJS.ErrnoException | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        callback(error, "", 0);
      } else if (address !== undefined) {
        callback(null, address, family);
      }
    };
    const timeout = setTimeout(
      () => finish(lookupError("DNS lookup timed out", "ETIMEDOUT")),
      timeoutMs,
    );
    timeout.unref?.();

    void Promise.resolve()
      .then(() => resolver(hostname))
      .then(
        (addresses) => {
          if (
            addresses.length === 0 ||
            addresses.some((address) => !isPublicIpAddress(address))
          ) {
            finish(
              lookupError(
                "Relay hostname did not resolve exclusively to a public IP address",
                "EACCES",
              ),
            );
            return;
          }
          const entries = addresses
            .map((address) => ({ address, family: isIP(address) }))
            .filter(
              (entry) =>
                (entry.family === 4 || entry.family === 6) &&
                (!options.family || options.family === entry.family),
            ) as Array<{ address: string; family: 4 | 6 }>;
          if (entries.length === 0) {
            finish(lookupError("Relay hostname has no usable public IP address", "ENOTFOUND"));
            return;
          }
          if (options.all) {
            finish(null, entries);
          } else {
            finish(null, entries[0].address, entries[0].family);
          }
        },
        () => finish(lookupError("Relay hostname lookup failed", "ENOTFOUND")),
      );
  };
}

export async function validateDmRelayUrl(
  value: string,
  resolver: HostnameResolver = resolveHostname,
): Promise<string | null> {
  if (value.length === 0 || value.length > MAX_RELAY_URL_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "wss:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.hostname.length === 0 ||
    url.hostname.toLowerCase() === "localhost"
  ) {
    return null;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch {
      return null;
    }
  }
  if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) {
    return null;
  }
  return url.toString();
}
