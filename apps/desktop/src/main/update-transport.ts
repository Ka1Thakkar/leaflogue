import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { BETA_RELEASES_API } from "./update-feed";
import type { UpdateTransport } from "./update-service";

/**
 * HTTPS for update checks and downloads only. Requests go to GitHub's release
 * hosts and nowhere else, follow at most a few redirects (GitHub serves
 * release assets from a separate host), send no cookies or reading data, and
 * stop at the caller's byte limit. The signed manifest, not this transport,
 * is what makes an update trustworthy; this only keeps the traffic narrow.
 */

const UPDATE_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

export function isAllowedUpdateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (UPDATE_HOSTS.has(url.hostname) || url.toString() === BETA_RELEASES_API) && !url.username && !url.password && (url.port === "" || url.port === "443");
  } catch {
    return false;
  }
}

type Requester = typeof request;

function open(url: string, userAgent: string, signal: AbortSignal | undefined, requester: Requester, redirects = 0): Promise<IncomingMessage> {
  if (!isAllowedUpdateUrl(url)) return Promise.reject(new Error("Update address is not allowed"));
  return new Promise((resolve, reject) => {
    const outgoing = requester(url, { method: "GET", headers: { "user-agent": userAgent, accept: "application/octet-stream" }, signal, timeout: REQUEST_TIMEOUT_MS }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        const location = response.headers.location;
        if (!location || redirects >= MAX_REDIRECTS) return reject(new Error("Too many update redirects"));
        void open(new URL(location, url).toString(), userAgent, signal, requester, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`Update request failed with status ${status}`));
      }
      resolve(response);
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("Update request timed out")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function consume(response: IncomingMessage, maxBytes: number, onChunk: (chunk: Uint8Array) => Promise<void> | void): Promise<void> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new Error("Update response is larger than allowed");
  }
  let total = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new Error("Update response is larger than allowed");
    }
    await onChunk(chunk);
  }
}

export function createUpdateTransport(appVersion: string, requester: Requester = request): UpdateTransport {
  const userAgent = `Leaflogue/${appVersion}`;
  return {
    async getBytes(url, maxBytes, signal) {
      const chunks: Uint8Array[] = [];
      await consume(await open(url, userAgent, signal, requester), maxBytes, (chunk) => { chunks.push(chunk); });
      return Buffer.concat(chunks);
    },
    async download(url, maxBytes, write, signal) {
      await consume(await open(url, userAgent, signal, requester), maxBytes, write);
    },
  };
}
