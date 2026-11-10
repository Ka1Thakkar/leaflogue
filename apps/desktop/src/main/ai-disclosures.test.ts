import { describe, expect, it, vi } from "vitest";
import { AiDisclosureLedger } from "./ai-disclosures";

describe("AI disclosure ledger", () => {
  it("binds the exact provider, model, and material behind an opaque id", () => {
    const ledger = new AiDisclosureLedger<{ passage: string }>(() => 1_000);
    const id = ledger.issue({ providerId: "gemini", model: "flash", material: { passage: "Shown text" } });
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(ledger.resolve(id)).toEqual({
      providerId: "gemini",
      model: "flash",
      material: { passage: "Shown text" },
      expiresAt: 601_000,
    });
  });

  it("rejects unknown and expired disclosures", () => {
    const now = vi.fn(() => 1_000);
    const ledger = new AiDisclosureLedger(now);
    const id = ledger.issue({ providerId: "gemini", model: "flash", material: "text" });
    expect(() => ledger.resolve("missing")).toThrow(/expired or changed/);
    now.mockReturnValue(601_000);
    expect(() => ledger.resolve(id)).toThrow(/expired or changed/);
  });

  it("rejects a provider or model selected after the disclosure", () => {
    const ledger = new AiDisclosureLedger(() => 1_000);
    const id = ledger.issue({ providerId: "gemini", model: "flash", material: "text" });
    expect(() => ledger.resolveFor(id, "openai", "flash")).toThrow(/provider or model changed/);
    expect(() => ledger.resolveFor(id, "gemini", "pro")).toThrow(/provider or model changed/);
    expect(ledger.resolveFor(id, "gemini", "flash").material).toBe("text");
  });
});
