import { describe, expect, it } from "vitest";
import config from "./auth.config";

describe("Convex authentication configuration", () => {
  it("trusts only the deployment's own sign-in", () => {
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toMatchObject({ applicationID: "convex" });
  });
});
