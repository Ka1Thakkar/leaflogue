import { describe, expect, it } from "vitest";
import { luaList, luaString, luaTable, parseLuaData } from "./lua-data";

describe("Lua data reader", () => {
  it("reads the table shape KOReader writes, including %q line breaks and comments", () => {
    const table = parseLuaData(`-- we can read Lua syntax here!
return {
    ["annotations"] = {
        [1] = {
            ["text"] = "First line\\
second line with \\"quotes\\" and \\9tab",
            ["pageno"] = 12,
            ["highlighted"] = true,
        },
        [2] = { text = [==[long ]] string]==], ratio = -1.5e2, hex = 0x1F },
    },
    --[[ a block
    comment ]]
    ["empty"] = {},
    ["skipped"] = nil,
    "positional", 'single \\u{2014} quoted';
}
`);
    const [one, two] = luaList(luaTable(table, "annotations")) as Map<string, unknown>[];
    expect(one!.get("text")).toBe('First line\nsecond line with "quotes" and \ttab');
    expect(one!.get("pageno")).toBe(12);
    expect(one!.get("highlighted")).toBe(true);
    expect(two!.get("text")).toBe("long ]] string");
    expect(two!.get("ratio")).toBe(-150);
    expect(two!.get("hex")).toBe(31);
    expect(table.has("skipped")).toBe(false);
    expect(luaList(table)).toEqual(["positional", "single — quoted"]);
    expect(luaString(table, 1)).toBe("positional");
  });

  it("treats __proto__ as an ordinary key", () => {
    const table = parseLuaData('return { ["__proto__"] = { polluted = true } }');
    expect(table.get("__proto__")).toBeInstanceOf(Map);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ["code instead of data", 'os.execute("rm -rf ~")'],
    ["a function call value", "return { x = os.time() }"],
    ["an identifier value", "return { x = y }"],
    ["arithmetic", "return { x = 1 + 2 }"],
    ["string concatenation", 'return { x = "a" .. "b" }'],
    ["a function", "return { x = function() end }"],
    ["content after the table", "return {} print(1)"],
    ["an unterminated string", 'return { x = "open }'],
    ["an unknown escape", 'return { x = "\\q" }'],
    ["a raw line break in a quoted string", 'return { x = "a\nb" }'],
  ])("refuses %s", (_label, source) => {
    expect(() => parseLuaData(source)).toThrow(/Not a KOReader sidecar/);
  });

  it("refuses runaway nesting", () => {
    expect(() => parseLuaData(`return ${"{".repeat(40)}${"}".repeat(40)}`)).toThrow(/nested too deeply/);
  });
});
