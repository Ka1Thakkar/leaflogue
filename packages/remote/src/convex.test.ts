import { describe, expect, it, vi } from "vitest";
import { assertCompatibleConvexDeployment, checkConvex } from "./convex";

describe("Convex runtime status adapter", () => {
  it("checks only the public Leaflogue metadata query without credentials", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "success",
      value: { product: "leaflogue", schemaVersion: 17, mutationContractVersion: 22 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(checkConvex("https://quiet-otter-123.convex.cloud", { fetch: request }))
      .resolves.toEqual({ reachable: true, initialized: true, schemaVersion: 17, mutationContractVersion: 22 });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe("https://quiet-otter-123.convex.cloud/api/query");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toMatchObject({ path: "setup:status", args: [{}] });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("rejects incompatible schema and mutation contract versions", async () => {
    for (const [metadata, problem] of [
      [{ product: "leaflogue", schemaVersion: 16, mutationContractVersion: 22 }, /supports Convex schema 17.*schema 16/],
      [{ product: "leaflogue", schemaVersion: 18, mutationContractVersion: 22 }, /supports Convex schema 17.*schema 18/],
      [{ product: "leaflogue", schemaVersion: 17, mutationContractVersion: 21 }, /supports Convex mutation contracts 22–23.*contract 21/],
      [{ product: "leaflogue", schemaVersion: 17, mutationContractVersion: 24 }, /supports Convex mutation contracts 22–23.*contract 24/],
    ] as const) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "success", value: metadata }), { status: 200 }));
      await expect(checkConvex("https://example.test", { fetch: request }))
        .resolves.toMatchObject({ reachable: true, initialized: false, problem: expect.stringMatching(problem) });
    }
  });

  it("preflights sync without a credential or library write and rejects an older backend", async () => {
    const paths: string[] = [];
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      paths.push(String(input));
      return new Response(JSON.stringify({ status: "success", value: {
        product: "leaflogue", schemaVersion: 17, mutationContractVersion: 20,
      } }), { status: 200 });
    });
    await expect(assertCompatibleConvexDeployment("https://example.test", { fetch: request }))
      .rejects.toMatchObject({ code: "LEAFLOGUE_CONVEX_VERSION_UNSUPPORTED" });
    expect(paths).toEqual(["https://example.test/api/query"]);
    expect(JSON.stringify(request.mock.calls)).not.toContain("syncKey");

    for (const mutationContractVersion of [22, 23]) {
      const compatible = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "success", value: {
        product: "leaflogue", schemaVersion: 17, mutationContractVersion,
      } }), { status: 200 }));
      await expect(assertCompatibleConvexDeployment("https://example.test", { fetch: compatible }))
        .resolves.toEqual({ mutationContractVersion });
    }
  });

  it("cancels a sync compatibility preflight when the desktop shuts down", async () => {
    const controller = new AbortController();
    const stalled = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private request detail")), { once: true });
      controller.abort();
    }));
    await expect(assertCompatibleConvexDeployment("https://example.test", { fetch: stalled, signal: controller.signal }))
      .rejects.toMatchObject({ code: "LEAFLOGUE_SYNC_CANCELLED" });
  });

  it("names the release-matched backend artifact and deploy command on mismatch", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "success",
      value: { product: "leaflogue", schemaVersion: 16, mutationContractVersion: 19 },
    }), { status: 200 }));
    await expect(checkConvex("https://example.test", { fetch: request, releaseVersion: "0.1.0" }))
      .resolves.toMatchObject({
        initialized: false,
        problem: expect.stringContaining("./leaflogue-convex-0.1.0/deploy.sh"),
      });
  });

  it("distinguishes invalid Leaflogue metadata from an unreachable deployment", async () => {
    const invalidMetadata = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "success",
      value: { product: "another-app", schemaVersion: 17, mutationContractVersion: 21 },
    }), { status: 200 }));
    await expect(checkConvex("https://example.test", { fetch: invalidMetadata }))
      .resolves.toMatchObject({ reachable: true, initialized: false, problem: expect.stringMatching(/metadata is invalid/) });

    const unavailable = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret upstream details"));
    const result = await checkConvex("https://example.test", { fetch: unavailable });
    expect(result).toEqual({
      reachable: false,
      initialized: false,
      problem: "Leaflogue could not reach the Convex deployment.",
    });
    expect(JSON.stringify(result)).not.toContain("secret upstream details");
  });

  it("reports a reachable deployment separately from a missing status function", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "error",
      errorMessage: "Could not find public function setup:status with internal details",
    }), { status: 560 }));

    const result = await checkConvex("https://example.test", { fetch: request });
    expect(result).toEqual({
      reachable: true,
      initialized: false,
      problem: "The Convex deployment responded, but its Leaflogue status function is unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain("internal details");
  });

  it("rejects unsafe URLs and unreasonable timeouts before making a request", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(checkConvex("https://user:secret@example.test", { fetch: request })).rejects.toThrow(/credential-free/);
    await expect(checkConvex("http://example.test", { fetch: request })).rejects.toThrow(/credential-free HTTPS/);
    await expect(checkConvex("https://example.test/not-an-origin", { fetch: request })).rejects.toThrow(/credential-free HTTPS/);
    await expect(checkConvex("https://example.test", { fetch: request, timeoutMs: 0 })).rejects.toThrow(/timeout is invalid/);
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds declared and streamed response bodies", async () => {
    const declaredOversize = vi.fn<typeof fetch>().mockResolvedValue(new Response("small", {
      status: 200,
      headers: { "content-length": String(64 * 1024 + 1) },
    }));
    await expect(checkConvex("https://example.test", { fetch: declaredOversize }))
      .resolves.toMatchObject({ reachable: true, initialized: false });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.close();
      },
    });
    const chunkedOversize = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status: 200 }));
    await expect(checkConvex("https://example.test", { fetch: chunkedOversize }))
      .resolves.toMatchObject({ reachable: true, initialized: false });
  });

  it("rejects responses redirected away from the configured deployment", async () => {
    const redirectedResponse = new Response(JSON.stringify({
      status: "success",
      value: { product: "leaflogue", schemaVersion: 17, mutationContractVersion: 21 },
    }), { status: 200 });
    Object.defineProperties(redirectedResponse, {
      redirected: { value: true },
      url: { value: "https://unexpected.example/api/query" },
    });
    const redirected = vi.fn<typeof fetch>().mockResolvedValue(redirectedResponse);

    await expect(checkConvex("https://example.test", { fetch: redirected }))
      .resolves.toMatchObject({ reachable: true, initialized: false });
  });

  it("applies the timeout signal to a stalled request", async () => {
    const stalled = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    }));
    await expect(checkConvex("https://example.test", { fetch: stalled, timeoutMs: 100 }))
      .resolves.toEqual({ reachable: false, initialized: false, problem: "Leaflogue could not reach the Convex deployment." });
  });
});
