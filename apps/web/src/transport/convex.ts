import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { BackendError, type Transport } from "./transport";

/** The subset of ConvexReactClient (or ConvexClient) the transport uses. */
export interface ConvexCaller {
  query(reference: ReturnType<typeof makeFunctionReference<"query">>, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: ReturnType<typeof makeFunctionReference<"mutation">>, args: Record<string, unknown>): Promise<unknown>;
  action(reference: ReturnType<typeof makeFunctionReference<"action">>, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Leaflogue's functions report what a reader should see as a ConvexError
 * with a code and message. Anything else is hidden by a production
 * deployment, so it gets a general message instead of Convex's wrapper text.
 */
export function backendError(error: unknown): BackendError {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: unknown; message?: unknown } | string;
    if (typeof data === "string") return new BackendError(data);
    return new BackendError(typeof data.message === "string" ? data.message : "The library could not complete that request.", typeof data.code === "string" ? data.code : undefined);
  }
  return new BackendError("The library could not complete that request. Try again shortly.");
}

export function convexTransport(client: ConvexCaller): Transport {
  const call = async <T>(run: () => Promise<unknown>): Promise<T> => {
    try {
      return await run() as T;
    } catch (error) {
      throw backendError(error);
    }
  };
  return {
    query: (name, args) => call(() => client.query(makeFunctionReference<"query">(name), args)),
    mutation: (name, args) => call(() => client.mutation(makeFunctionReference<"mutation">(name), args)),
    action: (name, args) => call(() => client.action(makeFunctionReference<"action">(name), args)),
  };
}
