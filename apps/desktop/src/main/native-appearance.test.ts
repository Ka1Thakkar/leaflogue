import { describe, expect, it, vi } from "vitest";
import { appearanceConfiguration } from "@leaflogue/appearance";
import { applyNativeAppearance } from "./native-appearance";

describe("native appearance", () => {
  it.each([
    ["light", true, "#faf4ed"],
    ["dark", false, "#191724"],
    ["system", false, "#faf4ed"],
    ["system", true, "#191724"],
  ] as const)("applies %s with system dark=%s", (mode, systemDark, expected) => {
    const nativeTheme = { themeSource: "system" as const, shouldUseDarkColors: systemDark };
    const window = { setBackgroundColor: vi.fn() };
    expect(applyNativeAppearance(appearanceConfiguration({ themeId: "rose-pine", mode }), nativeTheme, window)).toBe(expected);
    expect(nativeTheme.themeSource).toBe(mode);
    expect(window.setBackgroundColor).toHaveBeenCalledWith(expected);
  });
});
