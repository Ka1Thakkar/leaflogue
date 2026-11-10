import { randomUUID } from "node:crypto";

const DISCLOSURE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_DISCLOSURES = 32;

export interface BoundAiDisclosure<Material> {
  readonly providerId: string;
  readonly model: string;
  readonly material: Material;
  readonly expiresAt: number;
}

/**
 * Keeps AI task payloads inside the trusted process and gives the renderer only
 * a short-lived opaque reference. This makes the send use exactly the material,
 * provider, and model that were disclosed, even if UI state changes meanwhile.
 */
export class AiDisclosureLedger<Material> {
  readonly #entries = new Map<string, BoundAiDisclosure<Material>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(input: Omit<BoundAiDisclosure<Material>, "expiresAt">): string {
    this.#prune();
    while (this.#entries.size >= MAX_DISCLOSURES) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
    const id = randomUUID();
    this.#entries.set(id, { ...input, expiresAt: this.#now() + DISCLOSURE_LIFETIME_MS });
    return id;
  }

  resolve(id: string): BoundAiDisclosure<Material> {
    this.#prune();
    const disclosure = this.#entries.get(id);
    if (!disclosure) throw new Error("That AI disclosure expired or changed. Review it again before sending.");
    return disclosure;
  }

  resolveFor(id: string, providerId: string, model: string): BoundAiDisclosure<Material> {
    const disclosure = this.resolve(id);
    if (disclosure.providerId !== providerId || disclosure.model !== model) {
      throw new Error("The selected AI provider or model changed. Review the disclosure again before sending.");
    }
    return disclosure;
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(id);
    }
  }
}
