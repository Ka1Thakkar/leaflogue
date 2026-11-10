import { describe, expect, it } from "vitest";
import { appearanceConfiguration } from "@leaflogue/appearance";
import { AppearanceLiveState } from "./appearance-live-state";

describe("live appearance state", () => {
  it("preserves the last complete theme when a watched replacement is invalid", () => {
    const state = new AppearanceLiveState();
    state.describe(appearanceConfiguration({ themeId: "rose-pine", mode: "dark" }));
    const failed = state.reload(appearanceConfiguration(undefined, "Theme manifest is invalid"));
    expect(failed).toMatchObject({
      activate: false,
      configuration: { themeId: "rose-pine", mode: "dark", problem: "Theme manifest is invalid" },
    });
    const repaired = state.reload(appearanceConfiguration({ themeId: "nord", mode: "light" }));
    expect(repaired).toMatchObject({ activate: true, configuration: { themeId: "nord", mode: "light" } });
    expect(repaired.configuration).not.toHaveProperty("problem");
  });

  it("uses the safe startup fallback when no earlier valid theme exists", () => {
    const state = new AppearanceLiveState();
    expect(state.describe(appearanceConfiguration(undefined, "Unreadable custom theme")))
      .toMatchObject({ themeId: "leaflogue", mode: "system", problem: "Unreadable custom theme" });
  });

  it("reports a saved configuration's own problem and clears a stale one", () => {
    const state = new AppearanceLiveState();
    state.describe(appearanceConfiguration(undefined, "Unreadable custom theme"));
    expect(state.save(appearanceConfiguration({ themeId: "nord", mode: "dark" }))).not.toHaveProperty("problem");
    expect(state.save(appearanceConfiguration({ themeId: "nord", mode: "dark" }, "Theme overrides were not applied")))
      .toMatchObject({ themeId: "nord", problem: "Theme overrides were not applied" });
  });
});
