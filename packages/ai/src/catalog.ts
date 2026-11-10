import type { AiProviderId } from "./ai";

/**
 * Providers Leaflogue can call, with the environment variable that holds each
 * one's API key. The desktop reads keys from its protected config or these
 * variables; a server reads them only from its own environment (or the secret
 * manager it maps into the environment), which is the self-hoster's to set.
 */
export const AI_PROVIDER_KEY_VARIABLES: Readonly<Record<AiProviderId, string>> = Object.freeze({
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "openai-compatible": "LEAFLOGUE_AI_OPENAI_COMPATIBLE_KEY",
});

/** The endpoint for an OpenAI-compatible provider (for example a self-hosted model server). */
export const AI_OPENAI_COMPATIBLE_ENDPOINT_VARIABLE = "LEAFLOGUE_AI_OPENAI_COMPATIBLE_ENDPOINT";

export const AI_PROVIDER_IDS: readonly AiProviderId[] = Object.freeze(Object.keys(AI_PROVIDER_KEY_VARIABLES) as AiProviderId[]);

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

/** A model ID as providers spell them: letters, digits, dots, dashes, underscores, slashes, colons. */
export function isAiModelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

/**
 * Providers with a ready-made model list, so a free Google AI Studio key works
 * with no model typed in. Review these IDs against Google's current free-tier
 * models when releasing.
 */
export interface AiProviderDefaults {
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly capabilities: readonly string[];
  readonly apiKeyEnv: string;
}

export const DEFAULT_AI_PROVIDERS: Readonly<Partial<Record<AiProviderId, AiProviderDefaults>>> = Object.freeze({
  gemini: Object.freeze({
    // Models the free tier serves reliably; newer previews are often busy or slow.
    models: Object.freeze(["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"]),
    defaultModel: "gemini-2.5-flash",
    capabilities: Object.freeze(["chat", "structured-output"]),
    apiKeyEnv: AI_PROVIDER_KEY_VARIABLES.gemini,
  }),
});
