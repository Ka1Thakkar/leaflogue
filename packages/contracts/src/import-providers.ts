/** Import identities shared by parsers, UI, and both hosted backends. */
export const IMPORT_PROVIDERS = ["kindle", "kobo", "koreader", "pocketbook", "tolino", "boox", "portable", "goodreads"] as const;
export type ImportProvider = typeof IMPORT_PROVIDERS[number];

export const IMPORT_PROVIDER_NAMES: Readonly<Record<ImportProvider, string>> = {
  kindle: "Kindle", kobo: "Kobo", koreader: "KOReader", pocketbook: "PocketBook",
  tolino: "Tolino", boox: "Boox", portable: "Portable", goodreads: "Goodreads",
};

export function isImportProvider(value: unknown): value is ImportProvider {
  return typeof value === "string" && Object.hasOwn(IMPORT_PROVIDER_NAMES, value);
}

/** Hosts supply a file stem; source naming follows the same policy everywhere. */
export function suggestedImportSourceName(provider: ImportProvider, stem: string): string {
  const name = IMPORT_PROVIDER_NAMES[provider];
  const clean = stem.trim();
  return clean && !/^\d+ files$/u.test(clean) && clean.toLocaleLowerCase("en") !== name.toLocaleLowerCase("en")
    ? `${name} — ${clean}`.slice(0, 200) : `${name} library`;
}
