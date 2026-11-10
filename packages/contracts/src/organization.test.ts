import { describe, expect, it } from "vitest";
import { normalizeOrganizationName } from "./index";

describe("organisation name normalization", () => {
  it("uses one Unicode-aware key across local and online providers", () => {
    expect(normalizeOrganizationName("  ÉTÉ   Reads  ")).toBe("été reads");
    expect(normalizeOrganizationName("E\u0301te\u0301 Reads")).toBe("été reads");
    expect(normalizeOrganizationName("Ｅｓｓａｙｓ")).toBe("essays");
  });
});
