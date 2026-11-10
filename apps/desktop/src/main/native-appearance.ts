import type { AppearanceConfiguration, AppearanceMode } from "@leaflogue/contracts";

interface NativeThemeLike {
  themeSource: AppearanceMode;
  readonly shouldUseDarkColors: boolean;
}

interface WindowLike {
  setBackgroundColor(color: string): void;
}

export function applyNativeAppearance(
  appearance: AppearanceConfiguration,
  nativeTheme: NativeThemeLike,
  window?: WindowLike,
): string {
  nativeTheme.themeSource = appearance.mode;
  const background = nativeAppearanceBackground(appearance, nativeTheme.shouldUseDarkColors);
  window?.setBackgroundColor(background);
  return background;
}

export function nativeAppearanceBackground(appearance: AppearanceConfiguration, systemDark: boolean): string {
  const theme = appearance.themes.find(({ id }) => id === appearance.themeId) ?? appearance.themes[0];
  const dark = appearance.mode === "dark" || (appearance.mode === "system" && systemDark);
  return theme ? (dark ? theme.dark.paper : theme.light.paper) : "#fbf6ea";
}
