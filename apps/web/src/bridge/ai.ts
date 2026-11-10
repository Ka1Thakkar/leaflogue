import type { AiConfigurationSummary, AiProviderConfigurationSummary, AiTaskDisclosure, HighlightId, LeaflogueBridge } from "@leaflogue/contracts";
import { BackendError } from "../transport/transport";
import { storage, type LibraryClient } from "./client";
import type { WirePassage, WireShelfBook } from "./wire";

/**
 * Passage explanations through the backend's companion. Provider keys live
 * in the server's environment; the library keeps the chosen provider and
 * model. The backend has no off switch and no record of accepted terms, so
 * both are remembered in this browser.
 */

interface WireAiSettings {
  readonly providers: readonly {
    readonly id: string;
    readonly configured: boolean;
    readonly models: readonly string[];
    readonly defaultModel?: string;
  }[];
  readonly selected: { readonly provider: string; readonly model: string } | null;
}

interface CompanionAnswer {
  readonly answer: string;
}

interface Disclosed {
  readonly highlightId: HighlightId;
  readonly providerId: string;
  readonly model: string;
  readonly notes: readonly string[];
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  mistral: "Mistral",
  xai: "xAI",
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI-compatible",
};
/** Providers whose free tier may use what is sent to improve their products. */
const FREE_TIER_TRAINING = new Set(["gemini"]);
/** The companion's preset opening (COMPANION_PROMPTS.explain in @leaflogue/ai), which skips its scope check. */
const EXPLAIN_PROMPT = "Explain this passage.";
/** The companion's limit on one question (MAX_COMPANION_PROMPT_CHARACTERS). */
const MAX_PROMPT_CHARACTERS = 2_000;
const NOTES_HEADING = "\n\nMy notes on this passage:";
const KEPT_DISCLOSURES = 20;

const CONSENT_KEY = "leaflogue:ai-consent";
const DISABLED_KEY = "leaflogue:ai-disabled";

function consented(): Set<string> {
  try {
    const saved = JSON.parse(storage.get(CONSENT_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** The reader's notes that fit in one companion question, whole and in order. */
function notesThatFit(notes: readonly string[]): string[] {
  const kept: string[] = [];
  let length = EXPLAIN_PROMPT.length + NOTES_HEADING.length;
  for (const note of notes) {
    const line = `\n- ${note.trim()}`;
    if (length + line.length > MAX_PROMPT_CHARACTERS) break;
    kept.push(note.trim());
    length += line.length;
  }
  return kept;
}

function explainPrompt(notes: readonly string[]): string {
  return notes.length ? `${EXPLAIN_PROMPT}${NOTES_HEADING}${notes.map((note) => `\n- ${note}`).join("")}` : EXPLAIN_PROMPT;
}

export function createAi(client: LibraryClient): LeaflogueBridge["ai"] {
  const disclosures = new Map<string, Disclosed>();
  const cancelled = new Set<string>();

  async function describe(): Promise<AiConfigurationSummary> {
    const settings = await client.query<WireAiSettings>("aiRuntime:settings");
    const accepted = consented();
    const selected = settings.selected;
    const providers = settings.providers.flatMap((provider): AiProviderConfigurationSummary[] => {
      const chosen = selected?.provider === provider.id ? selected.model : undefined;
      // A provider with no listed models (a self-hosted endpoint) offers only the model already chosen for it.
      const models = provider.models.length ? provider.models : chosen ? [chosen] : [];
      const defaultModel = provider.defaultModel ?? models[0];
      if (!defaultModel) return [];
      return [{
        id: provider.id,
        models,
        defaultModel,
        selectedModel: chosen ?? defaultModel,
        capabilities: ["chat"],
        credential: provider.configured ? "environment" : "missing",
        consented: accepted.has(provider.id),
      }];
    });
    const active = providers.find(({ id }) => id === selected?.provider);
    return {
      enabled: active !== undefined && active.credential !== "missing" && storage.get(DISABLED_KEY) === null,
      ...(selected ? { selectedProvider: selected.provider } : {}),
      providers,
    };
  }

  return {
    describe,

    async save(input) {
      // Keys are set on the server, so `apiKey` and `clearSavedApiKey` do not apply here.
      if (input.enabled) {
        await client.mutation<null>("aiRuntime:setSettings", { provider: input.selectedProvider, model: input.selectedModel });
        storage.remove(DISABLED_KEY);
      } else {
        storage.set(DISABLED_KEY, "1");
      }
      return describe();
    },

    async acceptTerms(providerId) {
      const accepted = consented();
      accepted.add(providerId);
      storage.set(CONSENT_KEY, JSON.stringify([...accepted]));
      const summary = await describe();
      // Browser storage may refuse the write; the reader still accepted for this request.
      return { ...summary, providers: summary.providers.map((provider) => provider.id === providerId ? { ...provider, consented: true } : provider) };
    },

    async describeExplainTask(bookId, highlightId, includeNotes): Promise<AiTaskDisclosure> {
      const [summary, passage, book] = await Promise.all([
        describe(),
        client.query<WirePassage | null>("browse:highlight", { highlightId }),
        client.query<WireShelfBook | null>("browse:book", { bookId }),
      ]);
      if (!summary.enabled) throw new BackendError("AI features are turned off. Turn them on in Settings.", "LEAFLOGUE_AI_UNCONFIGURED");
      const provider = summary.providers.find(({ id }) => id === summary.selectedProvider);
      if (!provider) throw new BackendError("Choose an AI provider in Settings first.", "LEAFLOGUE_AI_UNCONFIGURED");
      if (!passage || !book || passage.bookId !== bookId) throw new BackendError("That passage is no longer in your library.", "LEAFLOGUE_NOT_FOUND");
      // The companion is given the passage and its book by ID; the notes travel in the question.
      const notes = includeNotes ? notesThatFit(passage.notes.map(({ markdown }) => markdown)) : [];
      const disclosureId = crypto.randomUUID();
      disclosures.set(disclosureId, { highlightId, providerId: provider.id, model: provider.selectedModel, notes });
      for (const stale of disclosures.keys()) {
        if (disclosures.size <= KEPT_DISCLOSURES) break;
        disclosures.delete(stale);
      }
      return {
        disclosureId,
        providerId: provider.id,
        providerName: PROVIDER_NAMES[provider.id] ?? provider.id,
        model: provider.selectedModel,
        trainsOnFreeTier: FREE_TIER_TRAINING.has(provider.id),
        consented: provider.consented,
        bookTitle: passage.bookTitle,
        authors: passage.bookAuthors,
        ...(book.series ? { series: book.series } : {}),
        ...(book.seriesNumber ? { seriesNumber: book.seriesNumber } : {}),
        ...(book.publisher ? { publisher: book.publisher } : {}),
        ...(book.description ? { description: book.description } : {}),
        passage: passage.text,
        notes,
      };
    },

    async explainPassage({ requestId, disclosureId }) {
      const disclosed = disclosures.get(disclosureId);
      if (!disclosed) throw new BackendError("This explanation request has expired. Open it again.", "LEAFLOGUE_AI_INVALID");
      try {
        const result = await client.action<CompanionAnswer>("aiRuntime:companion", {
          highlightId: disclosed.highlightId,
          prompt: explainPrompt(disclosed.notes),
          history: [],
        });
        if (cancelled.has(requestId)) throw new BackendError("The explanation was cancelled.", "LEAFLOGUE_AI_CANCELLED");
        return { providerId: disclosed.providerId, model: disclosed.model, explanation: result.answer };
      } finally {
        cancelled.delete(requestId);
      }
    },

    // The request cannot be stopped once sent; its answer is set aside when it arrives.
    async cancel(requestId) {
      cancelled.add(requestId);
    },
  };
}
