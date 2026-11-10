/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import { checkDeployment, normalizeDeployment, savedDeployment } from "./deployment";

describe("the reader's deployment", () => {
  it("accepts an https address or a Convex Cloud name, and nothing else", () => {
    expect(normalizeDeployment(" https://quiet-otter-123.convex.cloud/ ")).toBe("https://quiet-otter-123.convex.cloud");
    expect(normalizeDeployment("quiet-otter-123")).toBe("https://quiet-otter-123.convex.cloud");
    expect(normalizeDeployment("https://convex.example.org")).toBe("https://convex.example.org");
    for (const bad of ["http://quiet-otter-123.convex.cloud", "https://x.convex.cloud/api", "https://user:pass@x.convex.cloud", "not a url", ""]) {
      expect(normalizeDeployment(bad)).toBeUndefined();
    }
  });

  it("is remembered in this browser until forgotten", () => {
    savedDeployment.set("https://quiet-otter-123.convex.cloud");
    expect(savedDeployment.get()).toBe("https://quiet-otter-123.convex.cloud");
    savedDeployment.forget();
    expect(savedDeployment.get()).toBeUndefined();
  });

  it("must answer as a Leaflogue backend", async () => {
    await expect(checkDeployment("https://a.convex.cloud", () => Promise.resolve({ product: "leaflogue" }))).resolves.toBeUndefined();
    await expect(checkDeployment("https://a.convex.cloud", () => Promise.resolve({}))).rejects.toThrow("does not run Leaflogue");
    await expect(checkDeployment("https://a.convex.cloud", () => Promise.reject(new Error("404")))).rejects.toThrow("could not reach");
  });
});
