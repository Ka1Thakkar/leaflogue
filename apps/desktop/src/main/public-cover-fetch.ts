import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

function ipv4Bytes(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").map(Number);
}

function ipv6Words(address: string): readonly number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  const expandPart = (part: string): number[] => {
    if (!part) return [];
    return part.split(":").flatMap((word) => {
      const ipv4 = ipv4Bytes(word);
      return ipv4 ? [(ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!] : [Number.parseInt(word, 16)];
    });
  };
  const [left = "", right = "", ...extra] = address.toLowerCase().split("::");
  if (extra.length > 0) return undefined;
  const leading = expandPart(left);
  const trailing = expandPart(right);
  const missing = 8 - leading.length - trailing.length;
  if ((address.includes("::") ? missing < 1 : missing !== 0) || [...leading, ...trailing].some((word) => !Number.isInteger(word))) {
    return undefined;
  }
  return [...leading, ...Array.from({ length: missing }, () => 0), ...trailing];
}

/** Only globally routable unicast addresses may receive a pasted cover request. */
export function isPublicCoverAddress(address: string): boolean {
  const ipv4 = ipv4Bytes(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  const words = ipv6Words(address);
  if (!words) return false;
  const [first, second] = words;
  return (first! & 0xe000) === 0x2000 && !(
    first === 0x2002 ||
    (first === 0x2001 && (second! < 0x0200 || second === 0x0db8)) ||
    (first === 0x3fff && (second! & 0xf000) === 0)
  );
}

function responseAllowsBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

export function responseFromIncoming(incoming: IncomingMessage): Response {
  const status = incoming.statusCode ?? 500;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error("Cover server returned an invalid status");
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const body = responseAllowsBody(status)
    ? Readable.toWeb(incoming) as ReadableStream<Uint8Array>
    : null;
  if (!body) incoming.resume();
  return new Response(body, {
    status,
    statusText: incoming.statusMessage,
    headers,
  });
}

export async function resolvePublicCoverAddress(
  hostname: string,
  resolver: AddressResolver = async (name) => lookup(name, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>,
): Promise<ResolvedAddress> {
  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(literal);
  const addresses = family ? [{ address: literal, family: family as 4 | 6 }] : await resolver(literal);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicCoverAddress(address))) {
    throw new Error("Cover host does not resolve to a public address");
  }
  return addresses[0]!;
}

export function pinnedAddressLookup(resolved: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [resolved]);
    else callback(null, resolved.address, resolved.family);
  };
}

/** HTTPS fetch with DNS resolution pinned to the public address we validated. */
export async function fetchPublicCover(url: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const resolved = await resolvePublicCoverAddress(parsed.hostname);
  return new Promise<Response>((resolve, reject) => {
    const requestHeaders = new Headers(init.headers);
    const outgoing = request(parsed, {
      method: init.method ?? "GET",
      headers: Object.fromEntries(requestHeaders.entries()),
      signal: init.signal ?? undefined,
      lookup: pinnedAddressLookup(resolved),
    }, (incoming) => {
      try {
        resolve(responseFromIncoming(incoming));
      } catch (error) {
        incoming.destroy();
        reject(error instanceof Error ? error : new Error("Cover response could not be read"));
      }
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
