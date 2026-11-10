import { describe, expect, it } from "vitest";
import { applicationMenuTemplate } from "./application-menu";

describe("application menu", () => {
  it("hides the native menu outside macOS", () => {
    expect(applicationMenuTemplate("linux")).toBeUndefined();
    expect(applicationMenuTemplate("win32")).toBeUndefined();
  });

  it("keeps Quit and the editing shortcuts on macOS without a View menu", () => {
    const roles = applicationMenuTemplate("darwin")?.map((item) => item.role);
    expect(roles).toEqual(["appMenu", "editMenu", "windowMenu"]);
    expect(roles).not.toContain("viewMenu");
  });
});
