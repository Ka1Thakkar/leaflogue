import type { AppearanceConfiguration, AppearanceSettingsInput, LeaflogueBridge } from "@leaflogue/contracts";
import { appearanceConfiguration, BUILT_IN_THEMES, validateAppearanceSettings } from "@leaflogue/appearance";
import { desktopOnly, storage } from "./client";

/** The built-in themes, with the reader's choice kept in this browser. */

const APPEARANCE_KEY = "leaflogue:appearance";
const THEME_IDS: ReadonlySet<string> = new Set(BUILT_IN_THEMES.map(({ id }) => id));

function saved(): Partial<AppearanceSettingsInput> | undefined {
  try {
    const value = JSON.parse(storage.get(APPEARANCE_KEY) ?? "null") as unknown;
    return value && typeof value === "object" ? value as Partial<AppearanceSettingsInput> : undefined;
  } catch {
    return undefined;
  }
}

function current(): AppearanceConfiguration {
  return appearanceConfiguration(saved());
}

export function createAppearance(): LeaflogueBridge["appearance"] {
  return {
    describe: async () => current(),
    async save(input) {
      const settings = validateAppearanceSettings(input, THEME_IDS);
      storage.set(APPEARANCE_KEY, JSON.stringify(settings));
      return appearanceConfiguration(settings);
    },
    exportTheme: () => desktopOnly("Exporting a theme"),
    importTheme: () => desktopOnly("Importing a theme"),
    openThemesFolder: () => desktopOnly("Opening the themes folder"),
    // Another tab changed the theme.
    onChanged(listener) {
      const changed = (event: StorageEvent) => {
        if (event.key === APPEARANCE_KEY || event.key === null) listener(current());
      };
      window.addEventListener("storage", changed);
      return () => window.removeEventListener("storage", changed);
    },
  };
}
