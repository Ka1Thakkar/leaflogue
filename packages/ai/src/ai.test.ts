import { describe, expect, it, vi } from "vitest";
import { AiRateLimitError, generateAiText, type AiProviderId } from "./ai";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("provider-neutral AI text adapters", () => {
  it.each([
    ["openai", { status: "incomplete", output_text: "It describes the" }],
    ["anthropic", { stop_reason: "max_tokens", content: [{ text: "It describes the" }] }],
    ["gemini", { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "It describes the" }] } }] }],
    ["mistral", { choices: [{ finish_reason: "length", message: { content: "It describes the" } }] }],
  ] as const)("rejects an incomplete %s answer rather than showing it as final", async (id, payload) => {
    await expect(generateAiText({ id, model: "model-a", apiKey: "key" }, { prompt: "Explain this passage" }, vi.fn().mockResolvedValue(jsonResponse(payload))))
      .rejects.toThrow("stopped before finishing");
  });

  it.each([
    ["openai", { output: [{ content: [{ type: "output_text", text: " OpenAI answer " }] }] }, "https://api.openai.com/v1/responses", "authorization"],
    ["anthropic", { content: [{ type: "text", text: " Anthropic answer " }] }, "https://api.anthropic.com/v1/messages", "x-api-key"],
    ["gemini", { candidates: [{ content: { parts: [{ text: " Gemini answer " }] } }] }, "https://generativelanguage.googleapis.com/v1beta/models/model-a:generateContent", "x-goog-api-key"],
    ["mistral", { choices: [{ message: { content: " Mistral answer " } }] }, "https://api.mistral.ai/v1/chat/completions", "authorization"],
    ["xai", { choices: [{ message: { content: " xAI answer " } }] }, "https://api.x.ai/v1/chat/completions", "authorization"],
    ["deepseek", { choices: [{ message: { content: " DeepSeek answer " } }] }, "https://api.deepseek.com/chat/completions", "authorization"],
  ] as const)("serializes and parses %s without leaking its key", async (id, response, expectedUrl, credentialHeader) => {
    const request = vi.fn().mockResolvedValue(jsonResponse(response));
    const result = await generateAiText({ id, model: "model-a", apiKey: "secret-key" }, { prompt: "Explain this passage", system: "Be concise", maxOutputTokens: 50 }, request);
    expect(result).toEqual({ provider: id, model: "model-a", text: expect.stringContaining("answer") });
    const [url, rawInit] = request.mock.calls[0]!;
    const init = rawInit as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(expectedUrl);
    expect(headers[credentialHeader]).toContain("secret-key");
    expect(String(init.body)).not.toContain("secret-key");
  });

  it("supports a validated loopback OpenAI-compatible endpoint", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "Local answer" } }] }));
    await expect(generateAiText({ id: "openai-compatible", model: "local", apiKey: "key", endpoint: "http://127.0.0.1:11434/v1" }, { prompt: "Hello" }, request)).resolves.toMatchObject({ text: "Local answer" });
    expect(request.mock.calls[0]![0]).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("rejects unsafe endpoints, oversized prompts, invalid limits, errors, and empty output", async () => {
    const compatible = (endpoint: string) => ({ id: "openai-compatible" as AiProviderId, model: "local", apiKey: "key", endpoint });
    await expect(generateAiText(compatible("http://remote.test/v1"), { prompt: "Hello" }, vi.fn())).rejects.toThrow(/endpoint/);
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "x".repeat(300_000) }, vi.fn())).rejects.toThrow(/prompt/);
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello", maxOutputTokens: 0 }, vi.fn())).rejects.toThrow(/limit/);
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello", timeoutMs: 0 }, vi.fn())).rejects.toThrow(/timeout is invalid/);
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello" }, vi.fn().mockResolvedValue(jsonResponse({ error: "secret details" }, 401)))).rejects.toThrow("status 401");
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello" }, vi.fn().mockResolvedValue(jsonResponse({ output: [] })))).rejects.toThrow(/no text/);
  });

  it("bounds chunked responses and cancels before consuming later chunks", async () => {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(reads === 1 ? 1_500_000 : 700_000));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await expect(generateAiText(
      { id: "openai", model: "model", apiKey: "key" },
      { prompt: "Hello" },
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    )).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
    expect(reads).toBe(2);
  });

  it("owns a timeout, preserves cancellation, and sanitizes network failures", async () => {
    const stalled = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("secret.internal/path")), { once: true });
    }));
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello", timeoutMs: 1 }, stalled)).rejects.toThrow("timed out");

    const controller = new AbortController();
    controller.abort();
    const cancelledFetch = vi.fn();
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello", signal: controller.signal }, cancelledFetch)).rejects.toThrow("was cancelled");
    expect(cancelledFetch).not.toHaveBeenCalled();

    const failed = vi.fn().mockRejectedValue(new Error("getaddrinfo secret.internal/path"));
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello" }, failed)).rejects.toThrow("could not be reached");
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello" }, failed)).rejects.not.toThrow(/secret\.internal/);
  });

  it("sanitizes cancellation and timeout while reading a delayed body", async () => {
    const delayedResponse = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(new Error("secret streaming transport")), { once: true });
      },
    })));
    const controller = new AbortController();
    const cancelled = generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello", signal: controller.signal }, delayedResponse);
    await Promise.resolve();
    controller.abort();
    await expect(cancelled).rejects.toThrow("was cancelled");

    await expect(generateAiText(
      { id: "openai", model: "model", apiKey: "key" },
      { prompt: "Hello", timeoutMs: 1 },
      delayedResponse,
    )).rejects.toThrow("timed out");
  });

  it("reports which free-tier limit was reached, with the provider's suggested wait", async () => {
    const perDay = new Response(JSON.stringify({ error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), {
      status: 429,
      headers: { "content-type": "application/json", "content-length": "96", "retry-after": "45" },
    });
    const failure = await generateAiText({ id: "gemini", model: "gemini-3.8-flash", apiKey: "key" }, { prompt: "Hello" }, vi.fn().mockResolvedValue(perDay))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiRateLimitError);
    expect(failure).toMatchObject({ provider: "gemini", scope: "day", retryAfterMs: 45_000 });
    expect((failure as Error).message).toBe("The gemini per-day request limit was reached. Try again in 45 seconds.");

    const perMinute = new Response(JSON.stringify({ error: { message: "Quota exceeded for quota metric per minute" } }), {
      status: 429,
      headers: { "content-type": "application/json", "content-length": "72" },
    });
    await expect(generateAiText({ id: "gemini", model: "gemini-3.8-flash", apiKey: "key" }, { prompt: "Hello" }, vi.fn().mockResolvedValue(perMinute)))
      .rejects.toMatchObject({ scope: "minute", retryAfterMs: undefined });
  });

  it("says a busy model is busy, not rate limited, after trying once more", async () => {
    const busy = vi.fn().mockImplementation(async () => new Response("{}", { status: 503 }));
    const failure = await generateAiText({ id: "gemini", model: "gemini-2.5-flash", apiKey: "key" }, { prompt: "Hello" }, busy).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiRateLimitError);
    expect((failure as Error).message).toMatch(/^The gemini model is busy right now\./u);
    expect(busy).toHaveBeenCalledTimes(2);
  });

  it("honours a short suggested wait exactly once instead of retrying in a loop", async () => {
    const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    const succeeded = vi.fn()
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ content: { parts: [{ text: "Recovered" }] } }] }));
    await expect(generateAiText({ id: "gemini", model: "gemini-3.8-flash", apiKey: "key" }, { prompt: "Hello" }, succeeded))
      .resolves.toMatchObject({ text: "Recovered" });
    expect(succeeded).toHaveBeenCalledTimes(2);

    const exhausted = vi.fn().mockResolvedValue(limited());
    await expect(generateAiText({ id: "gemini", model: "gemini-3.8-flash", apiKey: "key" }, { prompt: "Hello" }, exhausted))
      .rejects.toBeInstanceOf(AiRateLimitError);
    expect(exhausted).toHaveBeenCalledTimes(2);
  });

  it("reports a long suggested wait instead of sleeping through it", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 503, headers: { "retry-after": "600" } }));
    await expect(generateAiText({ id: "openai", model: "model", apiKey: "key" }, { prompt: "Hello" }, fetcher))
      .rejects.toThrow("Try again in 600 seconds.");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("cancels unread bodies on early HTTP rejection", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
    await expect(generateAiText(
      { id: "openai", model: "model", apiKey: "key" },
      { prompt: "Hello" },
      vi.fn().mockResolvedValue(new Response(body, { status: 429 })),
    )).rejects.toThrow("status 429");
    expect(cancelled).toBe(true);
  });
});
