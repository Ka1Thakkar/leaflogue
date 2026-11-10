import type {
  BookId,
  ImportAnnotation,
  ImportConflict,
  ImportConflictId,
  LeaflogueBridge,
  SystemCapabilities,
  SystemHost,
} from "@leaflogue/contracts";
import type { Transport } from "../transport/transport";
import { createAi } from "./ai";
import { createAppearance } from "./appearance";
import { desktopOnly, LibraryClient } from "./client";
import { createDashboards, createWidgets } from "./dashboards";
import { createLibrary } from "./library";
import { createFileImports } from "./imports";
import { createDaily, createOrganization, createThreads } from "./organization";
import type { WireShelfBook } from "./wire";

export interface WebBridgeOptions {
  readonly transport: Transport;
  readonly libraryId: string;
  readonly host: Extract<SystemHost, { readonly kind: "web" }>;
  readonly signOut: () => Promise<void>;
  /** On Convex: sign out and choose another deployment. */
  readonly changeDeployment?: () => Promise<void>;
}

interface WireImportConflict {
  readonly id: ImportConflictId;
  readonly sourceName: string;
  readonly bookId: BookId;
  /** The annotation as the source last gave it, and as it gives it now, as JSON. */
  readonly previous: string;
  readonly incoming: string;
  readonly createdAt: number;
}

function platform(): SystemCapabilities["platform"] {
  const name = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  if (/mac/iu.test(name)) return "darwin";
  if (/win/iu.test(name)) return "win32";
  return "linux";
}

function annotation(json: string): ImportAnnotation {
  try {
    const value = JSON.parse(json) as unknown;
    if (value && typeof value === "object") return value as ImportAnnotation;
  } catch { /* Shown as an empty version below. */ }
  return { providerRecordId: "", bookProviderRecordId: "" };
}


/** The interface's `window.leaflogue`, over a library on a hosted backend. */
export function createWebBridge(options: WebBridgeOptions): LeaflogueBridge {
  const client = new LibraryClient(options.transport, options.libraryId);
  const { library, statistics } = createLibrary(client);
  const fileImports = createFileImports(client);

  const capabilities = (): SystemCapabilities => ({
    host: options.host,
    appVersion: "web",
    databaseSchemaVersion: 0,
    features: { ai: true, metadata: false, sync: false },
    persistenceAvailable: true,
    setupRequired: false,
    platform: platform(),
    storagePaths: { configFile: "", libraryFile: "", cacheDirectory: "", stateDirectory: "" },
  });

  return {
    host: options.host,
    system: {
      getCapabilities: async () => capabilities(),
      completeSetup: async () => capabilities(),
      async openExternal(url) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { return false; }
        if (parsed.protocol !== "https:") return false;
        if (!window.confirm(`Open this link in a new tab?\n\n${parsed.href}`)) return false;
        window.open(parsed.href, "_blank", "noopener,noreferrer");
        return true;
      },
    },
    library,
    covers: {
      // The browser loads the image itself; only https covers are shown.
      async resolve(sourceUrl) {
        try {
          const parsed = new URL(sourceUrl);
          return parsed.protocol === "https:" ? { url: parsed.href } : undefined;
        } catch {
          return undefined;
        }
      },
      cancel: async () => undefined,
    },
    organization: createOrganization(client),
    threads: createThreads(client),
    daily: createDaily(client),
    imports: {
      ...fileImports,
      chooseFolder: () => desktopOnly("Choosing a folder or a plugged-in reader"),
      listReaders: async () => [],
      chooseReader: () => desktopOnly("Choosing a folder or a plugged-in reader"),
      onReadersChanged: () => () => undefined,
      async listConflicts() {
        const conflicts = await client.query<WireImportConflict[]>("importRuntime:listConflicts");
        const titles = new Map<BookId, Promise<string>>();
        const titleOf = (bookId: BookId) => {
          let title = titles.get(bookId);
          if (!title) {
            title = client.query<WireShelfBook | null>("browse:book", { bookId }).then((book) => book?.title ?? "A removed book");
            titles.set(bookId, title);
          }
          return title;
        };
        return Promise.all(conflicts.map(async (conflict): Promise<ImportConflict> => {
          const base = annotation(conflict.previous);
          const incoming = annotation(conflict.incoming);
          return {
            id: conflict.id,
            sourceName: conflict.sourceName,
            bookTitle: await titleOf(conflict.bookId),
            kind: incoming.text?.trim() || base.text?.trim() ? "highlight" : "note",
            base,
            // The backend does not return the reader's current version; the
            // last accepted source version is the closest it has.
            local: base,
            incoming,
            createdAt: conflict.createdAt,
          };
        }));
      },
      async resolveConflict(input) {
        await client.mutation<null>("importRuntime:resolveConflict", {
          conflictId: input.id,
          resolution: input.resolution === "use-incoming" ? "accept-incoming" : "keep-local",
        });
      },
    },
    session: { signOut: options.signOut, ...(options.changeDeployment ? { changeDeployment: options.changeDeployment } : {}) },
    // The library lives on the backend, so there is nothing to sync.
    sync: {
      listConflicts: async () => ({ conflicts: [], total: 0 }),
      resolveConflict: () => desktopOnly("Reviewing synced versions"),
      run: () => desktopOnly("Syncing"),
      status: async () => ({ state: "off" }),
      onStatus: () => () => undefined,
    },
    backups: {
      create: () => desktopOnly("Making a backup"),
      restore: () => desktopOnly("Restoring a backup"),
    },
    exports: {
      create: () => desktopOnly("Exporting the library"),
      createMarkdown: () => desktopOnly("Exporting Markdown"),
    },
    statistics,
    dashboards: createDashboards(client),
    widgets: createWidgets(),
    updates: {
      check: () => desktopOnly("Checking for updates"),
      install: () => desktopOnly("Installing updates"),
      describe: async () => ({ automaticCheck: false }),
      setAutomaticCheck: () => desktopOnly("Checking for updates"),
      onAvailable: () => () => undefined,
    },
    remote: {
      describe: async () => ({ configured: false }),
      save: () => desktopOnly("Connecting a sync database"),
      check: () => desktopOnly("Connecting a sync database"),
      initialize: () => desktopOnly("Connecting a sync database"),
    },
    ai: createAi(client),
    appearance: createAppearance(),
  };
}
