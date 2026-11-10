import { makeFunctionReference } from "convex/server";
import { ConvexError, convexToJson, jsonToConvex, type Value } from "convex/values";
import type { convexTest } from "convex-test";

type Backend = ReturnType<typeof convexTest>;

/**
 * Serve the Convex HTTP protocol from an in-process convex-test backend.
 * Plain errors are redacted to "Server Error" the way a production deployment
 * does, so only coded `ConvexError`s reach the client.
 */
export function convexFetch(target: () => Backend): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const kind = url.pathname === "/api/mutation" ? "mutation" : url.pathname === "/api/query" ? "query" : undefined;
    if (!kind) return new Response("Not found", { status: 404 });
    const { path, args } = JSON.parse(String(init?.body)) as { path: string; args: [unknown] };
    const caller = target();
    const decoded = jsonToConvex(args[0] as never) as Record<string, Value>;
    try {
      const value = kind === "mutation"
        ? await caller.mutation(makeFunctionReference<"mutation", Record<string, Value>, Value>(path), decoded)
        : await caller.query(makeFunctionReference<"query", Record<string, Value>, Value>(path), decoded);
      return Response.json({ status: "success", value: convexToJson(value as Value), logLines: [] });
    } catch (error) {
      if (error instanceof ConvexError) {
        return Response.json({ status: "error", errorMessage: error.message, errorData: convexToJson(error.data as Value), logLines: [] }, { status: 560 });
      }
      return Response.json({ status: "error", errorMessage: "Server Error", logLines: [] }, { status: 560 });
    }
  };
}

