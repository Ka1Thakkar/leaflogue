import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { convexTransport } from "./convex";

describe("Convex transport", () => {
  it("calls functions by name with their kind", async () => {
    const client = { query: vi.fn().mockResolvedValue([1]), mutation: vi.fn().mockResolvedValue(2), action: vi.fn().mockResolvedValue(3) };
    const transport = convexTransport(client);
    expect(await transport.query("browse:books", { libraryId: "l" })).toEqual([1]);
    expect(await transport.mutation("runtime:createBook", {})).toBe(2);
    expect(await transport.action("aiRuntime:companion", {})).toBe(3);
    expect(client.query).toHaveBeenCalledWith(expect.anything(), { libraryId: "l" });
  });

  it("passes on Leaflogue's coded errors and hides anything else", async () => {
    const coded = convexTransport({ query: () => Promise.reject(new ConvexError({ code: "LEAFLOGUE_ACCESS_DENIED", message: "You cannot open this library" })), mutation: vi.fn(), action: vi.fn() });
    await expect(coded.query("browse:books", {})).rejects.toMatchObject({ code: "LEAFLOGUE_ACCESS_DENIED", message: "You cannot open this library" });
    const hidden = convexTransport({ query: () => Promise.reject(new Error("[CONVEX Q(browse:books)] Server Error")), mutation: vi.fn(), action: vi.fn() });
    await expect(hidden.query("browse:books", {})).rejects.toMatchObject({ message: "The library could not complete that request. Try again shortly." });
  });
});
