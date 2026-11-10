// @vitest-environment edge-runtime

import { COMPANION_PROMPTS } from "@leaflogue/ai";
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { convexModules } from "./test.setup";

const OWNER = "https://host.example|owner";
const STRANGER = "https://host.example|stranger";
const BOOK = "55555555-5555-4555-8555-555555555555";
const PASSAGE = "66666666-6666-4666-8666-666666666666";

const provisionHostOwner = makeFunctionReference<"mutation", { identityTokenIdentifier: string }, { libraryId: string }>("access:provisionHostOwner");
const createBook = makeFunctionReference<"mutation", { libraryId: string; id: string; title: string; authors?: string[] }, unknown>("runtime:createBook");
const createHighlight = makeFunctionReference<"mutation", { libraryId: string; id: string; bookId: string; text: string }, unknown>("runtime:createHighlight");
const settings = makeFunctionReference<"query", { libraryId: string }, {
  providers: Array<{ id: string; configured: boolean; keyVariable: string; models: string[]; defaultModel?: string }>;
  selected: { provider: string; model: string } | null;
  hourlyLimit: number;
}>("aiRuntime:settings");
const setSettings = makeFunctionReference<"mutation", { libraryId: string; provider: string; model: string }, null>("aiRuntime:setSettings");
const companion = makeFunctionReference<"action", {
  libraryId: string; highlightId: string; secondaryHighlightId?: string; prompt: string;
  history: Array<{ role: "reader" | "companion"; text: string }>;
}, { answer: string; remaining: number; saveable: boolean }>("aiRuntime:companion");

/** A stand-in for Gemini that answers with the given texts in turn and records what it was asked. */
function gemini(...answers: string[]) {
  const calls: Array<{ url: string; body: unknown; key: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("x-goog-api-key") });
    const text = answers.shift() ?? "";
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

async function library() {
  const t = convexTest(schema, convexModules);
  const { libraryId } = await t.mutation(provisionHostOwner, { identityTokenIdentifier: OWNER });
  const owner = t.withIdentity({ tokenIdentifier: OWNER });
  await owner.mutation(createBook, { libraryId, id: BOOK, title: "The Glass Orchard", authors: ["Imogen Vale"] });
  await owner.mutation(createHighlight, { libraryId, id: PASSAGE, bookId: BOOK, text: "Every pane held a season." });
  return { t, owner, libraryId };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("AI companion for web clients", () => {
  it("offers only providers whose key the server has, and never returns the key", async () => {
    const { owner, libraryId } = await library();
    vi.stubEnv("GEMINI_API_KEY", "secret-gemini-key");
    const result = await owner.query(settings, { libraryId });
    expect(result.providers.find(({ id }) => id === "gemini")).toMatchObject({ configured: true, keyVariable: "GEMINI_API_KEY", defaultModel: expect.any(String) });
    expect(result.providers.find(({ id }) => id === "openai")).toMatchObject({ configured: false, keyVariable: "OPENAI_API_KEY" });
    expect(JSON.stringify(result)).not.toContain("secret-gemini-key");
    expect(result.selected).toBeNull();
    await expect(owner.mutation(setSettings, { libraryId, provider: "openai", model: "gpt-5-mini" })).rejects.toThrow("OPENAI_API_KEY");
    await expect(owner.mutation(setSettings, { libraryId, provider: "gemini", model: "bad model!" })).rejects.toThrow("not valid");
    await owner.mutation(setSettings, { libraryId, provider: "gemini", model: "gemini-3.8-flash" });
    expect((await owner.query(settings, { libraryId })).selected).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
  });

  it("explains a passage with the chosen provider, sending only the passage", async () => {
    const { owner, libraryId } = await library();
    vi.stubEnv("GEMINI_API_KEY", "secret-gemini-key");
    await owner.mutation(setSettings, { libraryId, provider: "gemini", model: "gemini-3.8-flash" });
    const calls = gemini("Each pane frames a season.");
    const result = await owner.action(companion, { libraryId, highlightId: PASSAGE, prompt: COMPANION_PROMPTS.explain, history: [] });
    expect(result).toEqual({ answer: "Each pane frames a season.", remaining: 29, saveable: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("gemini-3.8-flash");
    expect(calls[0]!.key).toBe("secret-gemini-key");
    expect(JSON.stringify(calls[0]!.body)).toContain("Every pane held a season.");
  });

  it("checks a typed question is about the passage before answering it", async () => {
    const { owner, libraryId } = await library();
    vi.stubEnv("GEMINI_API_KEY", "secret-gemini-key");
    await owner.mutation(setSettings, { libraryId, provider: "gemini", model: "gemini-3.8-flash" });
    const calls = gemini("OUT_OF_SCOPE");
    const result = await owner.action(companion, { libraryId, highlightId: PASSAGE, prompt: "Write my cover letter", history: [] });
    expect(result).toMatchObject({ answer: "I can only help discuss this saved passage.", saveable: false });
    expect(calls).toHaveLength(1);
  });

  it("enforces the hourly limit, the provider choice, and library access", async () => {
    const { t, owner, libraryId } = await library();
    const ask = () => owner.action(companion, { libraryId, highlightId: PASSAGE, prompt: COMPANION_PROMPTS.explain, history: [] });
    await expect(ask()).rejects.toThrow("Choose an AI provider");
    vi.stubEnv("GEMINI_API_KEY", "secret-gemini-key");
    vi.stubEnv("LEAFLOGUE_AI_HOURLY_LIMIT", "1");
    await owner.mutation(setSettings, { libraryId, provider: "gemini", model: "gemini-3.8-flash" });
    gemini("First answer.");
    await expect(ask()).resolves.toMatchObject({ remaining: 0 });
    await expect(ask()).rejects.toThrow("this hour's AI requests");
    const stranger = t.withIdentity({ tokenIdentifier: STRANGER });
    await expect(stranger.action(companion, { libraryId, highlightId: PASSAGE, prompt: COMPANION_PROMPTS.explain, history: [] }))
      .rejects.toThrow("LEAFLOGUE_ACCESS_DENIED");
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(ask()).rejects.toThrow("GEMINI_API_KEY");
  });
});
