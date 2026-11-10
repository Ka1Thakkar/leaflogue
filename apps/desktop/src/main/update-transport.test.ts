import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { request } from "node:https";
import { describe, expect, it } from "vitest";
import { createUpdateTransport, isAllowedUpdateUrl } from "./update-transport";

type Route = { status: number; headers?: Record<string, string>; body?: string };

/** A stand-in for https.request that answers from a table of routes. */
function requester(routes: Record<string, Route>, seen: string[] = []) {
  return ((url: string, _options: unknown, callback: (response: unknown) => void) => {
    seen.push(url);
    const outgoing = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    outgoing.destroy = (error?: Error) => { if (error) outgoing.emit("error", error); };
    outgoing.end = () => {
      const route = routes[url];
      if (!route) return outgoing.emit("error", new Error("no route"));
      const response = Object.assign(Readable.from(route.body ? [Buffer.from(route.body)] : []), {
        statusCode: route.status,
        headers: route.headers ?? {},
      });
      callback(response);
    };
    return outgoing;
  }) as unknown as typeof request;
}

const MANIFEST = "https://github.com/Ka1Thakkar/leaflogue/releases/latest/download/leaflogue-update-stable-x64.json";
const ASSET = "https://release-assets.githubusercontent.com/github-production-release-asset/1/manifest";

describe("update transport", () => {
  it("only allows HTTPS to GitHub's release hosts", () => {
    expect(isAllowedUpdateUrl(MANIFEST)).toBe(true);
    expect(isAllowedUpdateUrl(ASSET)).toBe(true);
    expect(isAllowedUpdateUrl("http://github.com/x")).toBe(false);
    expect(isAllowedUpdateUrl("https://evil.example/x")).toBe(false);
    expect(isAllowedUpdateUrl("https://user:pass@github.com/x")).toBe(false);
    expect(isAllowedUpdateUrl("https://github.com:8443/x")).toBe(false);
  });

  it("follows GitHub's redirect to the asset host", async () => {
    const seen: string[] = [];
    const transport = createUpdateTransport("0.1.0", requester({
      [MANIFEST]: { status: 302, headers: { location: ASSET } },
      [ASSET]: { status: 200, body: "{}" },
    }, seen));
    await expect(transport.getBytes(MANIFEST, 100)).resolves.toEqual(Buffer.from("{}"));
    expect(seen).toEqual([MANIFEST, ASSET]);
  });

  it("refuses a redirect to any other host", async () => {
    const transport = createUpdateTransport("0.1.0", requester({
      [MANIFEST]: { status: 302, headers: { location: "https://evil.example/manifest" } },
    }));
    await expect(transport.getBytes(MANIFEST, 100)).rejects.toThrow(/not allowed/);
  });

  it("refuses responses over the byte limit, declared or streamed", async () => {
    const declared = createUpdateTransport("0.1.0", requester({ [MANIFEST]: { status: 200, headers: { "content-length": "500" }, body: "x" } }));
    await expect(declared.getBytes(MANIFEST, 100)).rejects.toThrow(/larger/);
    const streamed = createUpdateTransport("0.1.0", requester({ [MANIFEST]: { status: 200, body: "x".repeat(101) } }));
    await expect(streamed.getBytes(MANIFEST, 100)).rejects.toThrow(/larger/);
  });

  it("treats a missing release as a failed request", async () => {
    const transport = createUpdateTransport("0.1.0", requester({ [MANIFEST]: { status: 404 } }));
    await expect(transport.getBytes(MANIFEST, 100)).rejects.toThrow(/404/);
  });
});
