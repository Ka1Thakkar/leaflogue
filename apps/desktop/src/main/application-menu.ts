import type { MenuItemConstructorOptions } from "electron";

/**
 * Linux and Windows show no native menu. macOS always owns a menu bar, and
 * removing it also removes Quit, Hide, and the Copy/Paste shortcuts that the
 * Edit roles provide, so it keeps the standard roles and nothing that could
 * reload the page or open developer tools.
 */
export function applicationMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | undefined {
  if (platform !== "darwin") return undefined;
  return [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
}
