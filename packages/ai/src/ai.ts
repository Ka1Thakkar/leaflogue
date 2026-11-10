export type AiProviderId = "openai" | "anthropic" | "gemini" | "mistral" | "xai" | "deepseek" | "openai-compatible";

export interface AiRuntimeProvider {
  readonly id: AiProviderId;
  readonly model: string;
  readonly apiKey: string;
  readonly endpoint?: string;
}

export interface AiTextRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AiTextResponse {
  readonly provider: AiProviderId;
  readonly model: string;
  readonly text: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Which free-tier allowance a provider reported as exhausted. */
export type AiLimitScope = "minute" | "day" | "unknown";

/**
 * A provider refused the request because an allowance is exhausted. Free tiers
 * meter per minute and per day, so the reader is told which one was reached and
 * when it is worth trying again instead of seeing a bare status code.
 */
export class AiRateLimitError extends Error {
  readonly provider: AiProviderId;
  readonly scope: AiLimitScope;
  readonly retryAfterMs?: number;

  constructor(message: string, details: { provider: AiProviderId; scope: AiLimitScope; retryAfterMs?: number }) {
    super(message);
    this.name = "AiRateLimitError";
    this.provider = details.provider;
    this.scope = details.scope;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_LIMIT_DETAIL_BYTES = 8 * 1024;
/** The longest provider-suggested wait this adapter will absorb before it
 *  reports the limit instead. One retry only: a loop would burn a free tier. */
const MAX_AUTOMATIC_RETRY_MS = 2_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const DEFAULT_TIMEOUT_MS = 30_000;
const ENDPOINTS: Readonly<Record<Exclude<AiProviderId, "openai-compatible">, string>> = {
  openai: "https://api.openai.com/v1/responses",
  anthropic: "https://api.anthropic.com/v1/messages",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  xai: "https://api.x.ai/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
};

export async function generateAiText(provider: AiRuntimeProvider, request: AiTextRequest, fetchImplementation: Fetch = fetch): Promise<AiTextResponse> {
  validateRequest(provider, request);
  const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const serialized = serializeRequest(provider, request, maxOutputTokens);
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
  if (request.signal?.aborted) throw new Error("The AI request was cancelled");
  const send = async (): Promise<Response> => {
    try {
      return await fetchImplementation(serialized.url, {
        method: "POST",
        headers: serialized.headers,
        body: JSON.stringify(serialized.body),
        signal,
        redirect: "error",
      });
    } catch {
      if (request.signal?.aborted) throw new Error("The AI request was cancelled");
      if (timeoutSignal.aborted) throw new Error("The AI provider timed out");
      throw new Error("The AI provider could not be reached");
    }
  };
  let response = await send();
  if (!response.ok && isLimitStatus(response.status)) {
    const described = await describeLimit(provider.id, response);
    // A busy model is often free again a moment later: try once more.
    const limit = response.status === 503 && described.retryAfterMs === undefined ? { ...described, retryAfterMs: 1_000 } : described;
    // Honour a short provider-supplied wait once. Anything longer is the
    // reader's decision, so the limit is reported instead of slept through.
    if (limit.retryAfterMs !== undefined && limit.retryAfterMs <= MAX_AUTOMATIC_RETRY_MS) {
      await delay(limit.retryAfterMs, signal);
      if (request.signal?.aborted) throw new Error("The AI request was cancelled");
      if (timeoutSignal.aborted) throw new Error("The AI provider timed out");
      response = await send();
      if (!response.ok && isLimitStatus(response.status)) {
        throw limitError(provider.id, await describeLimit(provider.id, response), response.status);
      }
    } else {
      throw limitError(provider.id, limit, response.status);
    }
  }
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`The ${provider.id} request failed with status ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await cancelBody(response);
    throw new Error("The AI response is too large");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(response);
  } catch (error) {
    /* eslint-disable preserve-caught-error -- Transport causes may contain a private configured endpoint and must not cross this boundary. */
    if (request.signal?.aborted) throw new Error("The AI request was cancelled");
    if (timeoutSignal.aborted) throw new Error("The AI provider timed out");
    if (error instanceof Error && error.message === "The AI response is too large") throw error;
    throw new Error("The AI provider response could not be read");
    /* eslint-enable preserve-caught-error */
  }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("The AI provider returned invalid JSON"); }
  if (isTruncatedResponse(provider.id, payload)) throw new Error("The AI provider stopped before finishing the explanation. Try again or choose another model.");
  const text = parseText(provider.id, payload).trim();
  if (!text) throw new Error("The AI provider returned no text");
  return { provider: provider.id, model: provider.model, text };
}

function validateRequest(provider: AiRuntimeProvider, request: AiTextRequest): void {
  if (!provider.model || provider.model.length > 200 || !provider.apiKey.trim() || provider.apiKey.length > 8_192) throw new Error("AI provider configuration is invalid");
  if (!request.prompt.trim() || encodedLength(request.prompt) > MAX_PROMPT_BYTES || (request.system !== undefined && encodedLength(request.system) > MAX_PROMPT_BYTES)) throw new Error("AI prompt is invalid");
  if (request.maxOutputTokens !== undefined && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 16_384)) throw new Error("AI output limit is invalid");
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 120_000)) throw new Error("AI timeout is invalid");
  if (provider.id === "openai-compatible") validateCompatibleEndpoint(provider.endpoint);
  else if (provider.endpoint !== undefined) throw new Error("Built-in AI provider endpoints cannot be overridden");
}

function serializeRequest(provider: AiRuntimeProvider, request: AiTextRequest, maxOutputTokens: number): { url: string; headers: Record<string, string>; body: unknown } {
  const commonHeaders = { "content-type": "application/json" };
  if (provider.id === "openai") return {
    url: ENDPOINTS.openai,
    headers: { ...commonHeaders, authorization: `Bearer ${provider.apiKey}` },
    body: { model: provider.model, input: request.prompt, ...(request.system ? { instructions: request.system } : {}), max_output_tokens: maxOutputTokens },
  };
  if (provider.id === "anthropic") return {
    url: ENDPOINTS.anthropic,
    headers: { ...commonHeaders, "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" },
    body: { model: provider.model, messages: [{ role: "user", content: request.prompt }], ...(request.system ? { system: request.system } : {}), max_tokens: maxOutputTokens },
  };
  if (provider.id === "gemini") return {
    url: `${ENDPOINTS.gemini}/models/${encodeURIComponent(provider.model)}:generateContent`,
    headers: { ...commonHeaders, "x-goog-api-key": provider.apiKey },
    body: { contents: [{ role: "user", parts: [{ text: request.prompt }] }], ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}), generationConfig: { maxOutputTokens } },
  };
  const url = provider.id === "openai-compatible"
    ? `${provider.endpoint!.replace(/\/$/u, "")}/chat/completions`
    : ENDPOINTS[provider.id];
  return {
    url,
    headers: { ...commonHeaders, authorization: `Bearer ${provider.apiKey}` },
    body: { model: provider.model, messages: [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt }], max_tokens: maxOutputTokens },
  };
}

function parseText(provider: AiProviderId, payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (provider === "openai") {
    if (typeof payload.output_text === "string") return payload.output_text;
    if (!Array.isArray(payload.output)) return "";
    return payload.output.flatMap((item) => isRecord(item) && Array.isArray(item.content) ? item.content : [])
      .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
  }
  if (provider === "anthropic") {
    return Array.isArray(payload.content) ? payload.content.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n") : "";
  }
  if (provider === "gemini") {
    if (!Array.isArray(payload.candidates)) return "";
    return payload.candidates.flatMap((candidate) => isRecord(candidate) && isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [])
      .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!isRecord(choice) || !isRecord(choice.message)) return "";
  if (typeof choice.message.content === "string") return choice.message.content;
  return Array.isArray(choice.message.content)
    ? choice.message.content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n")
    : "";
}

/** A partial answer is worse than a clear failure: it can end mid-claim while
 * looking authoritative enough for the reader to keep as a note. */
function isTruncatedResponse(provider: AiProviderId, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (provider === "openai") return payload.status === "incomplete";
  if (provider === "anthropic") return payload.stop_reason === "max_tokens";
  if (provider === "gemini") {
    return Array.isArray(payload.candidates) && payload.candidates.some((candidate) =>
      isRecord(candidate) && candidate.finishReason === "MAX_TOKENS");
  }
  return Array.isArray(payload.choices) && payload.choices.some((choice) =>
    isRecord(choice) && choice.finish_reason === "length");
}

function validateCompatibleEndpoint(value: string | undefined): void {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error("OpenAI-compatible endpoint is invalid"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!url.hostname || (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) throw new Error("OpenAI-compatible endpoint is invalid");
}

function encodedLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The AI response is too large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isLimitStatus(status: number): boolean {
  return status === 429 || status === 503;
}

function limitError(provider: AiProviderId, limit: { scope: AiLimitScope; retryAfterMs?: number }, status: number): AiRateLimitError {
  const wait = limit.retryAfterMs === undefined ? "" : ` Try again in ${Math.max(1, Math.ceil(limit.retryAfterMs / 1_000))} seconds.`;
  // 503 means the model is overloaded, not that this reader used up an allowance.
  const message = status === 503
    ? `The ${provider} model is busy right now. Try again shortly, or choose another model in settings.${wait}`
    : limit.scope === "unknown"
    ? `The ${provider} request hit a rate limit (status ${status}).${wait}`
    : `The ${provider} per-${limit.scope} request limit was reached.${wait}`;
  return new AiRateLimitError(message, { provider, scope: limit.scope, ...(limit.retryAfterMs !== undefined ? { retryAfterMs: limit.retryAfterMs } : {}) });
}

/**
 * Classify an exhausted allowance without letting provider prose reach the
 * reader. Only the scope and the suggested wait are kept; the body is read at
 * all only when the provider declared a small one, so a stalled or oversized
 * error stream can never hold the request open.
 */
async function describeLimit(provider: AiProviderId, response: Response): Promise<{ scope: AiLimitScope; retryAfterMs?: number }> {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  let scope = headerLimitScope(response.headers);
  const declaredLength = Number(response.headers.get("content-length"));
  if (scope === "unknown" && Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength <= MAX_LIMIT_DETAIL_BYTES) {
    try {
      scope = bodyLimitScope(await response.text());
    } catch {
      // An unreadable error body only costs the scope, never the report.
    }
  }
  await cancelBody(response);
  return { scope, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

function headerLimitScope(headers: Headers): AiLimitScope {
  const remaining = (name: string) => {
    const header = headers.get(name);
    if (header === null || header.trim() === "") return undefined;
    const value = Number(header);
    return Number.isFinite(value) ? value : undefined;
  };
  if (remaining("x-ratelimit-remaining-requests") === 0 || remaining("x-ratelimit-remaining-tokens") === 0) return "minute";
  if (remaining("x-ratelimit-remaining-requests-day") === 0) return "day";
  return "unknown";
}

function bodyLimitScope(body: string): AiLimitScope {
  const text = body.slice(0, MAX_LIMIT_DETAIL_BYTES).toLowerCase().replace(/[_\s-]+/gu, "");
  if (text.includes("perday") || text.includes("daily") || text.includes("perdayperproject")) return "day";
  if (text.includes("perminute") || text.includes("permin")) return "minute";
  return "unknown";
}

/** Seconds or an HTTP date, bounded so a hostile value cannot stall a request. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  const milliseconds = Number.isFinite(seconds) && trimmed !== ""
    ? seconds * 1_000
    : Date.parse(trimmed) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.min(Math.round(milliseconds), 24 * 60 * 60 * 1_000);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Rejection is already terminal. */ }
}
