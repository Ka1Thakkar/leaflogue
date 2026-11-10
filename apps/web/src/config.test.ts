import { describe, expect, it } from "vitest";
import { loadWebConfig, parseWebConfig } from "./config";

const json = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));

describe("web configuration", () => {
  it("is the server only when the server says so", async () => {
    expect(await loadWebConfig(json({ backend: "server" }))).toEqual({ backend: "server" });
    expect(parseWebConfig({ backend: "convex", convexUrl: "https://someone-else.convex.cloud" })).toEqual({ backend: "convex" });
  });

  it("runs on Convex on any static host, whatever it answers", async () => {
    expect(await loadWebConfig(() => Promise.resolve(new Response("", { status: 404 })))).toEqual({ backend: "convex" });
    expect(await loadWebConfig(() => Promise.resolve(new Response("<!doctype html>", { headers: { "content-type": "text/html" } })))).toEqual({ backend: "convex" });
    expect(await loadWebConfig(() => Promise.reject(new TypeError("offline")))).toEqual({ backend: "convex" });
  });
});
