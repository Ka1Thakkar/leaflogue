import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const STORAGE_KEY = "leaflogue:convex-deployment";

/**
 * The reader's Convex deployment, as they typed it: a full https address, or
 * just its name ("quiet-otter-123"), which means Convex Cloud.
 */
export function normalizeDeployment(input: string): string | undefined {
  const text = input.trim().replace(/\/+$/u, "");
  const candidate = /^[a-z0-9-]+$/u.test(text) ? `https://${text}.convex.cloud` : text;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Remembered in this browser only; it is an address, not a secret. */
export const savedDeployment = {
  get(): string | undefined {
    try { return normalizeDeployment(window.localStorage.getItem(STORAGE_KEY) ?? ""); } catch { return undefined; }
  },
  set(url: string): void {
    try { window.localStorage.setItem(STORAGE_KEY, url); } catch { /* Asked for again next visit. */ }
  },
  forget(): void {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Nothing kept. */ }
  },
};

const status = makeFunctionReference<"query", Record<string, never>, { product?: string }>("setup:status");

/** Ask the deployment whether it runs Leaflogue, before offering to sign in to it. */
export async function checkDeployment(url: string, query: (url: string) => Promise<{ product?: string }> = (address) => new ConvexHttpClient(address).query(status, {})): Promise<void> {
  let answer: { product?: string };
  try {
    answer = await Promise.race([
      query(url),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
    ]);
  } catch {
    throw new Error("Leaflogue could not reach that deployment. Check the address, and that Leaflogue's backend is deployed to it.");
  }
  if (answer.product !== "leaflogue") throw new Error("That deployment does not run Leaflogue's backend.");
}
