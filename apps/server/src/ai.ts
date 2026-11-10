import {
  AI_OPENAI_COMPATIBLE_ENDPOINT_VARIABLE,
  AI_PROVIDER_IDS,
  AI_PROVIDER_KEY_VARIABLES,
  AiRateLimitError,
  companionInScope,
  companionNeedsScopeCheck,
  companionOutOfScope,
  companionRequest,
  companionScopeRequest,
  DEFAULT_AI_PROVIDERS,
  generateAiText,
  isAiModelId,
  isAiProviderId,
  parseCompanionAnswer,
  validateCompanionInput,
  type AiProviderId,
  type AiRuntimeProvider,
  type CompanionMessage,
} from "@leaflogue/ai";
import { livePassage, requireUser, type RequestContext } from "./context";
import { ServerError } from "./errors";

/**
 * The passage companion, as on Convex (`aiRuntime:*`). The reader picks a
 * provider and model in settings; the key comes only from the server's
 * environment and never reaches the database or a client.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURLY_LIMIT = 30;

type AiCode = "LEAFLOGUE_AI_UNCONFIGURED" | "LEAFLOGUE_AI_LIMIT" | "LEAFLOGUE_AI_FAILED" | "LEAFLOGUE_AI_INVALID";
const failure = (code: AiCode, message: string, status = 400) => new ServerError(code, message, status);

function hourlyLimit(env: RequestContext["config"]["env"]): number {
  const configured = Number(env.LEAFLOGUE_AI_HOURLY_LIMIT);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 1_000 ? configured : DEFAULT_HOURLY_LIMIT;
}

function configured(env: RequestContext["config"]["env"], id: AiProviderId): boolean {
  if (!env[AI_PROVIDER_KEY_VARIABLES[id]]?.trim()) return false;
  return id !== "openai-compatible" || Boolean(env[AI_OPENAI_COMPATIBLE_ENDPOINT_VARIABLE]?.trim());
}

async function savedChoice(context: RequestContext, libraryId: string): Promise<{ provider: AiProviderId; model: string } | null> {
  const saved = await context.client.query<{ provider: string; model: string }>(
    "SELECT provider, model FROM leaflogue_web.ai_settings WHERE library_id = $1",
    [libraryId],
  );
  const row = saved.rows[0];
  return row && isAiProviderId(row.provider) ? { provider: row.provider, model: row.model } : null;
}

export async function settings(context: RequestContext, libraryId: string) {
  const env = context.config.env;
  return {
    providers: AI_PROVIDER_IDS.map((id) => {
      const defaults = DEFAULT_AI_PROVIDERS[id];
      return {
        id,
        configured: configured(env, id),
        keyVariable: AI_PROVIDER_KEY_VARIABLES[id],
        models: defaults ? [...defaults.models] : [],
        ...(defaults ? { defaultModel: defaults.defaultModel } : {}),
      };
    }),
    selected: await savedChoice(context, libraryId),
    hourlyLimit: hourlyLimit(env),
  };
}

export async function setSettings(context: RequestContext, libraryId: string, args: { provider: AiProviderId; model: string }): Promise<null> {
  const model = args.model.trim();
  if (!isAiModelId(model)) throw failure("LEAFLOGUE_AI_INVALID", "That model name is not valid");
  if (!configured(context.config.env, args.provider)) {
    throw failure("LEAFLOGUE_AI_UNCONFIGURED", `Set ${AI_PROVIDER_KEY_VARIABLES[args.provider]} on the server to use this provider`);
  }
  await context.client.query(`
    INSERT INTO leaflogue_web.ai_settings (library_id, provider, model, updated_at) VALUES ($1, $2, $3, now())
    ON CONFLICT (library_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, updated_at = now()
  `, [libraryId, args.provider, model]);
  return null;
}

/** Count one request against the reader's hourly allowance, atomically. */
async function claimRequest(context: RequestContext): Promise<number> {
  const user = requireUser(context);
  const limit = hourlyLimit(context.config.env);
  const claimed = await context.client.query<{ requests: number }>(`
    INSERT INTO leaflogue_web.ai_request_windows AS windows (user_id, window_started_at, requests)
    VALUES ($1, now(), 1)
    ON CONFLICT (user_id) DO UPDATE SET
      window_started_at = CASE WHEN windows.window_started_at <= now() - make_interval(secs => $2) THEN now() ELSE windows.window_started_at END,
      requests = CASE WHEN windows.window_started_at <= now() - make_interval(secs => $2) THEN 1 ELSE windows.requests + 1 END
    WHERE windows.window_started_at <= now() - make_interval(secs => $2) OR windows.requests < $3
    RETURNING requests
  `, [user.userId, HOUR_MS / 1000, limit]);
  const requests = claimed.rows[0]?.requests;
  if (requests === undefined) throw failure("LEAFLOGUE_AI_LIMIT", "You have used this hour's AI requests. Try again later.", 429);
  return limit - Number(requests);
}

/**
 * One turn of the companion. Only the chosen passages and the conversation
 * leave the server. Saving an answer is the client's choice, through
 * runtime:createNote with origin "ai".
 */
export async function companion(context: RequestContext, libraryId: string, args: {
  highlightId: string;
  secondaryHighlightId?: string;
  prompt: string;
  history: CompanionMessage[];
}) {
  try {
    validateCompanionInput(args);
  } catch (error) {
    throw failure("LEAFLOGUE_AI_INVALID", error instanceof Error ? error.message : "That question is not valid");
  }
  if (args.secondaryHighlightId === args.highlightId) throw failure("LEAFLOGUE_AI_INVALID", "Choose two different passages");
  const resolve = async (id: string) => {
    const passage = await livePassage(context.client, libraryId, id);
    if (!passage) throw failure("LEAFLOGUE_AI_INVALID", "That passage no longer exists");
    return { bookTitle: passage.bookTitle, authors: passage.authors, passage: passage.text, ...passage.details };
  };
  const primary = await resolve(args.highlightId);
  const secondary = args.secondaryHighlightId ? await resolve(args.secondaryHighlightId) : undefined;
  const choice = await savedChoice(context, libraryId);
  if (!choice) throw failure("LEAFLOGUE_AI_UNCONFIGURED", "Choose an AI provider in Settings first");
  const env = context.config.env;
  const apiKey = env[AI_PROVIDER_KEY_VARIABLES[choice.provider]]?.trim();
  const endpoint = env[AI_OPENAI_COMPATIBLE_ENDPOINT_VARIABLE]?.trim();
  if (!apiKey || (choice.provider === "openai-compatible" && !endpoint)) {
    throw failure("LEAFLOGUE_AI_UNCONFIGURED", `Set ${AI_PROVIDER_KEY_VARIABLES[choice.provider]} on the server to use this provider`);
  }
  const provider: AiRuntimeProvider = {
    id: choice.provider,
    model: choice.model,
    apiKey,
    ...(choice.provider === "openai-compatible" && endpoint ? { endpoint } : {}),
  };
  const remaining = await claimRequest(context);
  const input = { primary, ...(secondary ? { secondary } : {}), prompt: args.prompt, history: args.history };
  try {
    if (companionNeedsScopeCheck(input)) {
      const verdict = await generateAiText(provider, companionScopeRequest(input), context.fetch);
      if (!companionInScope(verdict.text)) return { answer: companionOutOfScope(input), remaining, saveable: false };
    }
    const response = await generateAiText(provider, companionRequest(input), context.fetch);
    return { answer: parseCompanionAnswer(response.text), remaining, saveable: !secondary };
  } catch (error) {
    if (error instanceof AiRateLimitError) throw failure("LEAFLOGUE_AI_LIMIT", error.message, 429);
    if (error instanceof Error && /timed out/u.test(error.message)) {
      throw failure("LEAFLOGUE_AI_FAILED", "The AI provider took too long to answer. Try again, or choose a faster model in settings.", 504);
    }
    throw failure("LEAFLOGUE_AI_FAILED", "The AI provider could not answer right now. Try again shortly.", 502);
  }
}
