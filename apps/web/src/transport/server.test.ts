import { describe, expect, it, vi } from "vitest";
import { serverTransport } from "./server";
import { BackendError } from "./transport";

const reply = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("server transport", () => {
  it("posts the function and its arguments as JSON and returns the value", async () => {
    const fetcher = vi.fn(() => reply(200, { status: "success", value: [{ id: "b" }] }));
    expect(await serverTransport(fetcher).query("browse:books", { libraryId: "l" })).toEqual([{ id: "b" }]);
    expect(fetcher).toHaveBeenCalledWith("/api/run", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "browse:books", args: { libraryId: "l" } }),
    }));
  });

  it("passes on the server's own message and code", async () => {
    const fetcher = () => reply(409, { status: "error", errorMessage: "This passage changed elsewhere.", errorData: { code: "LEAFLOGUE_REVISION_CONFLICT" } });
    const error = await serverTransport(fetcher).mutation("runtime:updateHighlight", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ message: "This passage changed elsewhere.", code: "LEAFLOGUE_REVISION_CONFLICT", status: 409 });
  });

  it("says so when the server cannot be reached", async () => {
    const fetcher = () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(serverTransport(fetcher).action("aiRuntime:companion", {})).rejects.toMatchObject({ code: "LEAFLOGUE_OFFLINE" });
  });
});
