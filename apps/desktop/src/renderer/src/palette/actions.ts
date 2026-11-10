import type { AiConfigurationSummary, AppearanceConfiguration, AppearanceMode, ConnectedReader } from "@leaflogue/contracts";
import { activateAppearance } from "../appearance";
import { href, navigate, parseRoute } from "../router";
import { createChannel } from "./intents";

/** Whether AI actions may be offered: switched on, with a usable provider. */
export function aiAvailable(summary: AiConfigurationSummary | undefined): boolean {
  if (!summary?.enabled) return false;
  const selected = summary.selectedProvider ?? summary.providers[0]?.id;
  return summary.providers.some(({ id, credential }) => id === selected && credential !== "missing");
}

/** Sent when the palette saves a theme or mode, so an open Settings page shows it. */
export const APPEARANCE_SAVED_EVENT = "leaflogue:appearance-saved";

export async function saveAppearance(themeId: string, mode: AppearanceMode): Promise<void> {
  const result = await window.leaflogue.appearance.save({ themeId, mode });
  activateAppearance(result);
  window.dispatchEvent(new CustomEvent<AppearanceConfiguration>(APPEARANCE_SAVED_EVENT, { detail: result }));
}

/** Light or dark as the reader sees it now, resolving "follow this device". */
export function shownMode(appearance: AppearanceConfiguration): "light" | "dark" {
  if (appearance.mode !== "system") return appearance.mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** What the import page should start on when it opens. */
export type ImportRequest = { readonly kind: "reader"; readonly reader: ConnectedReader } | { readonly kind: "file" };
export const importRequests = createChannel<ImportRequest>();

export function startImport(request: ImportRequest): void {
  importRequests.send(request);
  if (parseRoute(window.location.hash).name !== "import") navigate(href.import());
}

/** Asks the library page to open its Add book dialog. */
export const addBookRequests = createChannel<null>();

export function addBook(): void {
  addBookRequests.send(null);
  if (parseRoute(window.location.hash).name !== "library") navigate(href.library());
}
