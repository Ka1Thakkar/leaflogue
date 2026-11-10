import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { isPublicCoverAddress, pinnedAddressLookup, resolvePublicCoverAddress, responseFromIncoming } from "./public-cover-fetch";

function incoming(status: number, body = ""): IncomingMessage {
  const stream = new PassThrough();
  const message = stream as unknown as IncomingMessage;
  message.statusCode = status;
  message.statusMessage = "Test";
  message.headers = { "content-type": "text/plain" };
  stream.end(body);
  return message;
}

describe("public cover network boundary", () => {
  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111",
  ])("accepts globally routable address %s", (address) => {
    expect(isPublicCoverAddress(address)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::1",
    "100::1",
    "2001:10::1",
    "2001:20::1",
    "2001:db8::1",
    "3fff::1",
    "4000::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicCoverAddress(address)).toBe(false);
  });

  it("accepts a public hostname and pins its first validated answer", async () => {
    const resolver = vi.fn(async () => [
      { address: "203.1.1.10", family: 4 as const },
      { address: "2606:4700:4700::1111", family: 6 as const },
    ]);
    await expect(resolvePublicCoverAddress("images.example", resolver)).resolves.toEqual({
      address: "203.1.1.10",
      family: 4,
    });
  });

  it("rejects the whole hostname when any DNS answer is private", async () => {
    const resolver = vi.fn(async () => [
      { address: "203.1.1.10", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ]);
    await expect(resolvePublicCoverAddress("mixed.example", resolver)).rejects.toThrow("public address");
  });

  it("returns the pinned address in both Node lookup callback forms", () => {
    const lookup = pinnedAddressLookup({ address: "203.1.1.10", family: 4 });
    const one = vi.fn();
    lookup("images.example", { all: false }, one);
    expect(one).toHaveBeenCalledWith(null, "203.1.1.10", 4);

    const all = vi.fn();
    lookup("images.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "203.1.1.10", family: 4 }]);
  });

  it.each([204, 205, 304])("constructs a body-free response for status %s", (status) => {
    const response = responseFromIncoming(incoming(status));
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it("turns a normal incoming response into a readable fetch response", async () => {
    const response = responseFromIncoming(incoming(200, "cover"));
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("cover");
  });

  it("rejects a status the fetch Response contract cannot represent", () => {
    expect(() => responseFromIncoming(incoming(700))).toThrow("invalid status");
  });
});
