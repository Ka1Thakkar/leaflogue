import { describe, expect, it } from "vitest";
import { rendererContentPolicy, rendererContentPolicyForRequest, validateDevelopmentRendererUrl } from "./content-policy";

describe("renderer content policy", () => {
  it("permits the local Vite preamble and HMR only during development", () => {
    const development = rendererContentPolicy(true);
    expect(development).toContain("script-src 'self' 'unsafe-eval' 'unsafe-inline'");
    expect(development).toContain("connect-src 'self' ws://localhost:* http://localhost:*");

    const production = rendererContentPolicy(false);
    expect(production).toContain("script-src 'self';");
    expect(production).toContain("connect-src 'none'");
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(production).not.toContain("localhost");
  });

  it("binds development exceptions to a validated loopback renderer origin", () => {
    const developmentUrl = validateDevelopmentRendererUrl("http://localhost:5173/");
    expect(rendererContentPolicyForRequest(false, developmentUrl, "http://localhost:5173/src/main.tsx"))
      .toContain("'unsafe-inline'");
    expect(rendererContentPolicyForRequest(false, developmentUrl, "leaflogue://app/index.html"))
      .not.toContain("'unsafe-eval'");
    expect(rendererContentPolicyForRequest(true, developmentUrl, "http://localhost:5173/"))
      .not.toContain("'unsafe-eval'");
    expect(() => validateDevelopmentRendererUrl("https://example.com/app"))
      .toThrow(/loopback HTTP URL/);
    expect(() => validateDevelopmentRendererUrl("http://reader:secret@localhost:5173/"))
      .toThrow(/loopback HTTP URL/);
  });
});
