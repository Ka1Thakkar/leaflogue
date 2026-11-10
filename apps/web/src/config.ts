/**
 * Which backend this copy of the web app talks to, read when the page loads.
 * apps/server answers /config.json itself. Anywhere else (any static host)
 * the app runs on Convex, and the reader names their own deployment; a host
 * never decides whose library the page opens.
 */
export type WebConfig = { readonly backend: "server" } | { readonly backend: "convex" };

export function parseWebConfig(value: unknown): WebConfig {
  const backend = typeof value === "object" && value !== null ? (value as { backend?: unknown }).backend : undefined;
  return backend === "server" ? { backend: "server" } : { backend: "convex" };
}

export async function loadWebConfig(fetchImplementation: typeof fetch = (input, init) => fetch(input, init)): Promise<WebConfig> {
  try {
    const response = await fetchImplementation("/config.json", { cache: "no-store" });
    // A static host may answer with its 404 page or index.html instead of JSON.
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) return { backend: "convex" };
    return parseWebConfig(await response.json());
  } catch {
    return { backend: "convex" };
  }
}
