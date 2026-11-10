import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverCache, normalizeTrustedCoverUrl } from "./cover-cache";

const temporaryDirectories: string[] = [];
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "leaflogue-cover-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cover cache", () => {
  it("accepts arbitrary standard HTTPS hosts and rejects unsafe URL forms", () => {
    expect(normalizeTrustedCoverUrl("https://covers.openlibrary.org/b/isbn/123-L.jpg#fragment"))
      .toBe("https://covers.openlibrary.org/b/isbn/123-L.jpg");
    expect(normalizeTrustedCoverUrl("https://images.independent-bookshop.example/cover.jpg"))
      .toBe("https://images.independent-bookshop.example/cover.jpg");
    expect(() => normalizeTrustedCoverUrl("http://covers.openlibrary.org/book.jpg")).toThrow("standard HTTPS");
    expect(() => normalizeTrustedCoverUrl("https://user:secret@covers.openlibrary.org/book.jpg")).toThrow("standard HTTPS");
    expect(() => normalizeTrustedCoverUrl("https://covers.openlibrary.org:444/book.jpg")).toThrow("standard HTTPS");
  });

  it("checks every redirect and writes credential-free private cache entries", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://ia800.example.archive.org/cover.png" } }))
      .mockResolvedValueOnce(new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const cache = new CoverCache(temporaryDirectory(), { fetcher, accentFromImage: () => "rgb(235 111 146)" });
    const first = await cache.resolve("https://covers.openlibrary.org/b/id/1-L.jpg?token=private");
    const second = await cache.resolve("https://covers.openlibrary.org/b/id/1-L.jpg?token=private");

    expect(first).toEqual(second);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readFileSync(first.path)).toEqual(Buffer.from(png));
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(first.path).not.toContain("private");
  });

  it("stores no accent for a cover with no colour to borrow", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const cache = new CoverCache(temporaryDirectory(), { fetcher, accentFromImage: () => undefined });
    const cover = await cache.resolve("https://covers.openlibrary.org/b/id/2-L.jpg");
    expect(cover.accent).toBeUndefined();
    // The reread entry agrees, so the active theme's placeholder colour keeps
    // charge across restarts instead of a colour from one palette.
    expect(cache.read(cover.key)?.accent).toBeUndefined();
  });

  it("rejects non-HTTPS redirects and mismatched image signatures", async () => {
    const redirected = new CoverCache(temporaryDirectory(), {
      fetcher: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/cover.png" } }),
      accentFromImage: () => "rgb(1 2 3)",
    });
    await expect(redirected.resolve("https://covers.openlibrary.org/b/id/1-L.jpg")).rejects.toThrow("standard HTTPS");

    const disguised = new CoverCache(temporaryDirectory(), {
      fetcher: async () => new Response(new TextEncoder().encode("not an image"), { status: 200, headers: { "content-type": "image/png" } }),
      accentFromImage: () => "rgb(1 2 3)",
    });
    await expect(disguised.resolve("https://books.google.com/cover.png")).rejects.toThrow("supported image");
  });

  it("cancels response streams that it will not consume", async () => {
    const redirectedCancel = vi.fn(async () => undefined);
    const redirectedBody = new ReadableStream<Uint8Array>({ cancel: redirectedCancel });
    const redirected = new CoverCache(temporaryDirectory(), {
      fetcher: async () => new Response(redirectedBody, {
        status: 302,
        headers: { location: "http://127.0.0.1/cover.png" },
      }),
      accentFromImage: () => undefined,
    });
    await expect(redirected.resolve("https://images.example/cover.png")).rejects.toThrow("standard HTTPS");
    expect(redirectedCancel).toHaveBeenCalledOnce();

    const rejectedCancel = vi.fn(async () => undefined);
    const rejected = new CoverCache(temporaryDirectory(), {
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({ cancel: rejectedCancel }), { status: 404 }),
      accentFromImage: () => undefined,
    });
    await expect(rejected.resolve("https://images.example/missing.png")).rejects.toThrow("downloaded");
    expect(rejectedCancel).toHaveBeenCalledOnce();

    const oversizedCancel = vi.fn(async () => undefined);
    const oversized = new CoverCache(temporaryDirectory(), {
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({ cancel: oversizedCancel }), {
        status: 200,
        headers: { "content-length": String(8 * 1024 * 1024 + 1), "content-type": "image/png" },
      }),
      accentFromImage: () => undefined,
    });
    await expect(oversized.resolve("https://images.example/large.png")).rejects.toThrow("too large");
    expect(oversizedCancel).toHaveBeenCalledOnce();
  });

  it("times out a stalled fetch and lets the caller cancel one", async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(
        init.signal?.reason instanceof Error ? init.signal.reason : new Error("cancelled"),
      ), { once: true });
    }));
    const cache = new CoverCache(temporaryDirectory(), { fetcher, accentFromImage: () => undefined }, { downloadTimeoutMs: 10 });
    await expect(cache.resolve("https://covers.openlibrary.org/b/id/stalled.jpg")).rejects.toThrow(/timed out/);

    const requestId = "11111111-1111-4111-8111-111111111111";
    const cancelled = cache.resolve("https://covers.openlibrary.org/b/id/cancelled.jpg", requestId);
    cache.cancel(requestId);
    await expect(cancelled).rejects.toThrow(/cancelled/);
  });

  it("bounds concurrent downloads", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    });
    const cache = new CoverCache(temporaryDirectory(), { fetcher, accentFromImage: () => undefined }, { maxConcurrency: 2 });
    const pending = [1, 2, 3].map((id) => cache.resolve(`https://covers.openlibrary.org/b/id/${id}.jpg`));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(pending);
    expect(peak).toBe(2);
  });

  it("evicts old entries to keep the private cache within its quota", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const cache = new CoverCache(temporaryDirectory(), { fetcher, accentFromImage: () => undefined }, { maxCacheBytes: 20 });
    const first = await cache.resolve("https://covers.openlibrary.org/b/id/quota-1.jpg");
    const second = await cache.resolve("https://covers.openlibrary.org/b/id/quota-2.jpg");
    expect([first.path, second.path].filter(existsSync)).toHaveLength(1);
  });
});
