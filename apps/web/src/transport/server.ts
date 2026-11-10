import { BackendError, type Transport } from "./transport";

interface RunResponse {
  readonly status?: "success" | "error";
  readonly value?: unknown;
  readonly errorMessage?: string;
  readonly errorData?: { readonly code?: string };
}

/** apps/server, on the same origin: every function is a POST to /api/run. */
export function serverTransport(fetchImplementation: typeof fetch = (input, init) => fetch(input, init)): Transport {
  async function run<T>(name: string, args: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetchImplementation("/api/run", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: name, args }),
      });
    } catch {
      throw new BackendError("Leaflogue could not reach the server. Check your connection and try again.", "LEAFLOGUE_OFFLINE");
    }
    const body = await response.json().catch(() => undefined) as RunResponse | undefined;
    if (!response.ok || body?.status !== "success") {
      throw new BackendError(body?.errorMessage ?? "The server could not complete that request.", body?.errorData?.code, response.status);
    }
    return body.value as T;
  }
  return { query: run, mutation: run, action: run };
}
