import type { AiConfigurationSummary, AiSettingsInput, AppearanceConfiguration, AppearanceSettingsInput, Book, BookContents, BookOrganization, Collection, DailyHighlight, DashboardId, DashboardLayouts, DashboardPlacement, Highlight, HighlightQuery, Note, ReadingStatusEvent, RemoteConfigurationSummary, SyncConflict, Tag, Thread, UpdateBookMetadata } from "@leaflogue/contracts";
import { appearanceConfiguration } from "@leaflogue/appearance";
import { previewDashboards as previewCustomDashboards, previewWidgetsBridge } from "./preview-widgets";

/**
 * An in-memory library for running the interface in a plain browser during
 * development and in the visual tests. Nothing here reaches a real library.
 */
export function installPreviewBridge(): void {
  const now = Date.now();
  let previewBook: Book = {
    id: "bd809783-25e1-4d95-80a0-d03442a57d5c" as never,
    title: "Piranesi",
    authors: ["Susanna Clarke"],
    description: "A house of infinite rooms, tides, statues, and one careful observer.",
    status: "reading",
    archived: false,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    highlightCount: 1,
    ...(new URLSearchParams(window.location.search).has("cover")
      ? { coverUrl: "https://covers.openlibrary.org/b/isbn/9781635575637-L.jpg" }
      : {}),
  };
  let targetBook: Book = {
    id: "ad97b895-7fd8-46af-8de1-c12b1ca284af" as never,
    title: "Jonathan Strange & Mr Norrell",
    authors: ["Susanna Clarke"],
    status: "finished",
    archived: false,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    highlightCount: 0,
  };
  let previewSyncConflicts: SyncConflict[] = new URLSearchParams(window.location.search).has("sync-conflicts") ? [{
    id: "5d1f2c7e-8a44-4c1b-9e0f-3b6a2d9c7e10" as never,
    kind: "note",
    bookId: "bd809783-25e1-4d95-80a0-d03442a57d5c" as never,
    bookTitle: "Piranesi",
    preservedBody: "The tides here feel like a liturgy: the House keeps its own calendar, and he keeps it with it.",
    preservedOnThisDevice: true,
    currentBody: "The tides are his calendar.",
    passageText: "Every room of the House keeps its weather; its stairs keep count.",
      restore: "copy",
    currentRevision: 3,
    createdAt: now,
  }, {
    id: "7a0e9b3c-1d2f-4e5a-8b6c-9d0e1f2a3b4c" as never,
    kind: "highlight",
    bookId: "ad97b895-7fd8-46af-8de1-c12b1ca284af" as never,
    bookTitle: "Jonathan Strange & Mr Norrell",
    preservedBody: "Can a magician kill a man by magic? Lord Wellington asked Strange.",
    preservedOnThisDevice: false,
    restore: "copy",
    currentRevision: 5,
    createdAt: now - 60_000,
  }] : [];
  let previewContents: BookContents = {
    book: previewBook,
    highlights: [{
      id: "98da45c8-a8ea-42fc-aaae-8d75ec12dc16" as never,
      bookId: previewBook.id,
      text: "Every room of the House keeps its weather; its stairs keep count.",
      createdAt: now,
      updatedAt: now,
      revision: 1,
      notes: [{
        id: "c6f3205a-3d79-424a-a078-8aec9a66c7a1" as never,
        bookId: previewBook.id,
        highlightId: "98da45c8-a8ea-42fc-aaae-8d75ec12dc16" as never,
        markdown: "A reminder that place can be both mystery and shelter.",
        origin: "import",
        createdAt: now,
        updatedAt: now,
        revision: 1,
      }],
    }],
    standaloneNotes: [],
  };
  let previewStatusHistory: ReadingStatusEvent[] = [{
    id: "72ed4f39-f7e7-40ae-8c5b-450ce678c0e1" as never,
    bookId: previewBook.id,
    status: "reading",
    source: "reader",
    changedAt: now - 3 * 24 * 60 * 60 * 1_000,
    bookRevision: 1,
  }];
  let previewDashboards: DashboardLayouts = previewCustomDashboards(new URLSearchParams(window.location.search));
  let previewAutomaticUpdates = false;
  let previewAiConfig: AiConfigurationSummary = {
    enabled: false,
    selectedProvider: "anthropic",
    providers: [
      { id: "anthropic", models: ["claude-sonnet", "claude-haiku"], defaultModel: "claude-sonnet", selectedModel: "claude-sonnet", capabilities: ["chat"], credential: "saved", consented: true },
      { id: "openai", models: ["gpt-standard", "gpt-mini"], defaultModel: "gpt-standard", selectedModel: "gpt-mini", capabilities: ["chat", "structured-output"], credential: "environment", consented: false },
      { id: "gemini", models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"], defaultModel: "gemini-2.5-flash", selectedModel: "gemini-2.5-flash", capabilities: ["chat", "structured-output"], credential: "missing", consented: false },
      { id: "openai-compatible", models: ["local-model"], defaultModel: "local-model", selectedModel: "local-model", endpoint: "http://127.0.0.1:11434/v1", capabilities: ["chat"], credential: "missing", consented: false },
    ],
  };
  // The browser preview can open in any theme: ?theme=nord&mode=light.
  const previewQuery = new URLSearchParams(window.location.search);
  let previewAppearance: AppearanceConfiguration = appearanceConfiguration({
    themeId: previewQuery.get("theme") ?? "rose-pine",
    mode: previewQuery.get("mode") === "light" ? "light" : "dark",
  });
  let previewRemoteConfig: RemoteConfigurationSummary = {
    configured: false,
  };
  let previewCollections: Collection[] = [{ id: "ba043082-c430-4ec1-a0dd-29fd80792fbd" as never, name: "Quiet wonders", description: "Books that reward close attention.", bookCount: 1, createdAt: now, updatedAt: now, revision: 1 }];
  let previewTags: Tag[] = [{ id: "a4f12f7f-ea09-45e3-a92a-d414ae8d4019" as never, name: "Revisit", color: "ochre", bookCount: 1, highlightCount: 1, createdAt: now, updatedAt: now, revision: 1 }];
  /**
   * Apply a change to the book a mutation actually names. The preview holds two
   * books, and a stub that edits whichever one it has to hand shows another
   * book wearing the edit you just made — a bug in the preview that is
   * indistinguishable from a bug in the product.
   */
  function changePreviewBook(id: Book["id"], change: (book: Book) => Book): Book {
    if (id === previewBook.id) {
      previewBook = change(previewBook);
      previewContents = { ...previewContents, book: previewBook };
      return previewBook;
    }
    if (id === targetBook.id) {
      targetBook = change(targetBook);
      return targetBook;
    }
    throw new Error("Book changed elsewhere or no longer exists");
  }

  let previewOrganization: BookOrganization = { bookId: previewBook.id, collectionIds: [previewCollections[0]!.id], tagIds: [previewTags[0]!.id], highlightTags: [{ highlightId: previewContents.highlights[0]!.id, tagIds: [previewTags[0]!.id] }] };
  let previewThreads: Thread[] = [{ id: "737b142b-13a4-424c-a909-55901c759eff" as never, name: "Impossible architecture", description: "Places that are larger on the inside.", passageCount: 1, createdAt: now, updatedAt: now, revision: 1 }];
  let previewMembership = [previewThreads[0]!.id];
  const previewDaily: DailyHighlight = {
    selection: { id: "582d4f52-e5cb-455f-a314-278b9253758e" as never, localDay: new Date().toISOString().slice(0, 10), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", highlightId: previewContents.highlights[0]!.id, candidateDigest: "preview", recentHighlightIds: [], selectedAt: now, updatedAt: now, revision: 1 },
    passage: { highlightId: previewContents.highlights[0]!.id, bookId: previewBook.id, bookTitle: previewBook.title, authors: previewBook.authors, text: previewContents.highlights[0]!.text, notes: previewContents.highlights[0]!.notes },
    hasAlternatives: false,
  };
  let mcpEnabled = false;
  const mcpClient = JSON.stringify({ mcpServers: { leaflogue: { command: "/opt/leaflogue/leaflogue", args: ["--mcp"] } } }, null, 2);
  Object.defineProperty(window, "leaflogue", {
    value: Object.freeze({
      system: Object.freeze({
        describeMcp: async () => ({ enabled: mcpEnabled, clientConfiguration: mcpClient }),
        configureMcp: async (enabled: boolean) => { mcpEnabled = enabled; return { enabled, clientConfiguration: mcpClient }; },
        getCapabilities: async () => ({
          appVersion: "0.0.0-dev",
          databaseSchemaVersion: 10,
          features: { ai: false, metadata: false, sync: true },
          persistenceAvailable: true,
          setupRequired: new URLSearchParams(window.location.search).has("setup"),
          platform: "linux" as const,
          storagePaths: {
            configFile: "/home/reader/.config/leaflogue/config.json",
            libraryFile: "/home/reader/.local/share/leaflogue/library.sqlite",
            cacheDirectory: "/home/reader/.cache/leaflogue",
            stateDirectory: "/home/reader/.local/state/leaflogue",
          },
        }),
        completeSetup: async () => ({
          ...(await window.leaflogue.system.getCapabilities()),
          setupRequired: false,
        }),
        openExternal: async (url: string) => window.confirm(`Open this link in your browser?\n${url}`),
      }),
      library: Object.freeze({
        findDuplicates: async () => ({ books: [], passages: [] }),
        listBooks: async (options?: { includeArchived?: boolean }) => [previewBook, targetBook].filter((book) => options?.includeArchived || !book.archived),
        createBook: async (input: { title: string; authors?: readonly string[]; isbn13?: string }) => ({
          id: crypto.randomUUID() as never,
          title: input.title.trim(),
          authors: input.authors ?? [],
          ...(input.isbn13 ? { isbn13: input.isbn13 } : {}),
          status: "unread" as const,
          archived: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: 1,
          highlightCount: 0,
        }),
        updateBookMetadata: async (input: UpdateBookMetadata) => changePreviewBook(input.id, (book) => ({
          // Metadata is replaced wholesale, so an omitted optional field is
          // cleared. Reading state is not metadata and survives the edit.
          id: book.id, status: book.status, archived: book.archived, createdAt: book.createdAt,
          highlightCount: book.highlightCount,
          ...(book.completedOn ? { completedOn: book.completedOn } : {}),
          title: input.title, authors: input.authors,
          ...(input.description ? { description: input.description } : {}),
          ...(input.publisher ? { publisher: input.publisher } : {}),
          ...(input.series ? { series: input.series } : {}),
          ...(input.seriesNumber ? { seriesNumber: input.seriesNumber } : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.isbn13 ? { isbn13: input.isbn13 } : {}),
          ...(input.coverUrl ? { coverUrl: input.coverUrl } : {}),
          revision: input.expectedRevision + 1,
          updatedAt: Date.now(),
        })),
        getMetadataSource: async (id: Book["id"]) => id === previewBook.id
          ? { sourceName: "Kobo Clara", lastSeenAt: now, values: { title: "Piranesi", authors: ["Susanna Clarke"], publisher: "Bloomsbury" } }
          : undefined,
        getBookContents: async (id: Book["id"]) => id === previewBook.id ? previewContents : id === targetBook.id ? { book: targetBook, highlights: [], standaloneNotes: [] } : undefined,
        listHighlights: async (query: HighlightQuery) => {
          const needle = query.search?.toLocaleLowerCase() ?? "";
          const entries = [previewContents]
            .filter(({ book }) => !book.archived && (!query.bookId || query.bookId === book.id))
            .flatMap(({ book, highlights }) => highlights.map((highlight) => ({
              ...highlight,
              bookTitle: book.title,
              authors: book.authors,
              imported: highlight.notes.some(({ origin }) => origin === "import"),
              tagIds: previewOrganization.highlightTags.find((entry) => entry.highlightId === highlight.id)?.tagIds ?? [],
            })))
            .filter((entry) => !needle || entry.text.toLocaleLowerCase().includes(needle) || entry.notes.some(({ markdown }) => markdown.toLocaleLowerCase().includes(needle)))
            .filter((entry) => !query.source || entry.imported === (query.source === "imported"))
            .filter((entry) => !query.notes || (entry.notes.length > 0) === (query.notes === "with"))
            .filter((entry) => !query.tagId || entry.tagIds.includes(query.tagId))
            .sort((left, right) => {
              if (query.sort !== "relevance" || !needle) return 0;
              const rank = (entry: typeof left) => {
                const text = entry.text.toLocaleLowerCase();
                if (text === needle) return 0;
                if (text.startsWith(needle)) return 1;
                if (text.includes(needle)) return 2;
                if (entry.notes.some(({ markdown }) => markdown.toLocaleLowerCase() === needle)) return 3;
                if (entry.notes.some(({ markdown }) => markdown.toLocaleLowerCase().startsWith(needle))) return 4;
                return 5;
              };
              return rank(left) - rank(right) || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id);
            });
          const offset = query.offset ?? 0;
          const limit = query.limit ?? 20;
          return { entries: entries.slice(offset, offset + limit), hasMore: entries.length > offset + limit };
        },
        createHighlight: async (input: { bookId: Book["id"]; text: string; sourceLocation?: string; noteMarkdown?: string }) => {
          const highlightId = crypto.randomUUID() as Highlight["id"];
          const note = input.noteMarkdown ? {
            id: crypto.randomUUID() as never,
            bookId: input.bookId,
            highlightId,
            markdown: input.noteMarkdown.trim(),
            origin: "reader" as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            revision: 1,
          } : undefined;
          const highlight = {
            id: highlightId,
            bookId: input.bookId,
            text: input.text.trim(),
            ...(input.sourceLocation ? { sourceLocation: input.sourceLocation.trim() } : {}),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            revision: 1,
            notes: note ? [note] : [],
          } satisfies Highlight;
          previewContents = { ...previewContents, book: { ...previewContents.book, highlightCount: previewContents.book.highlightCount + 1 }, highlights: [...previewContents.highlights, highlight] };
          return highlight;
        },
        updateHighlight: async (input: { id: Highlight["id"]; bookId: Book["id"]; text: string; sourceLocation?: string; expectedRevision: number }) => {
          const current = previewContents.highlights.find((highlight) => highlight.id === input.id)!;
          const updated = { ...current, text: input.text.trim(), ...(input.sourceLocation ? { sourceLocation: input.sourceLocation.trim() } : {}), updatedAt: Date.now(), revision: current.revision + 1 } satisfies Highlight;
          previewContents = { ...previewContents, highlights: previewContents.highlights.map((highlight) => highlight.id === input.id ? updated : highlight) };
          return updated;
        },
        createNote: async (input: { bookId: Book["id"]; highlightId?: Highlight["id"]; markdown: string; origin?: "reader" | "ai" }) => {
          const note = { id: crypto.randomUUID() as never, bookId: input.bookId, ...(input.highlightId ? { highlightId: input.highlightId } : {}), markdown: input.markdown.trim(), origin: input.origin ?? "reader", createdAt: Date.now(), updatedAt: Date.now(), revision: 1 } satisfies Note;
          previewContents = input.highlightId
            ? { ...previewContents, highlights: previewContents.highlights.map((highlight) => highlight.id === input.highlightId ? { ...highlight, notes: [...highlight.notes, note] } : highlight) }
            : { ...previewContents, standaloneNotes: [...previewContents.standaloneNotes, note] };
          return note;
        },
        updateNote: async (input: { id: Note["id"]; bookId: Book["id"]; markdown: string; expectedRevision: number }) => {
          let updated: Note | undefined;
          const replace = (note: Note) => note.id === input.id ? (updated = { ...note, markdown: input.markdown.trim(), origin: "reader", updatedAt: Date.now(), revision: note.revision + 1 }) : note;
          previewContents = { ...previewContents, highlights: previewContents.highlights.map((highlight) => ({ ...highlight, notes: highlight.notes.map(replace) })), standaloneNotes: previewContents.standaloneNotes.map(replace) };
          if (!updated) throw new Error("Note missing");
          return updated;
        },
        deleteHighlight: async (input: { id: Highlight["id"]; bookId: Book["id"]; expectedRevision: number }) => {
          const removed = previewContents.highlights.find((highlight) => highlight.id === input.id);
          previewContents = { ...previewContents, highlights: previewContents.highlights.filter((highlight) => highlight.id !== input.id) };
          return { bookId: input.bookId, bookRevision: previewBook.revision, revision: input.expectedRevision + 1, notesDeleted: removed?.notes.length ?? 0 };
        },
        deleteNote: async (input: { id: Note["id"]; bookId: Book["id"]; expectedRevision: number }) => {
          previewContents = {
            ...previewContents,
            highlights: previewContents.highlights.map((highlight) => ({ ...highlight, notes: highlight.notes.filter((note) => note.id !== input.id) })),
            standaloneNotes: previewContents.standaloneNotes.filter((note) => note.id !== input.id),
          };
          return { bookId: input.bookId, bookRevision: previewBook.revision, revision: input.expectedRevision + 1, notesDeleted: 1 };
        },
        getHighlightSource: async (bookId: Book["id"], highlightId: Highlight["id"]) => {
          const highlight = previewContents.highlights.find((entry) => entry.id === highlightId && entry.bookId === bookId);
          if (!highlight) return undefined;
          return {
            disclosureId: crypto.randomUUID(),
            sourceName: "Kobo Clara",
            text: "Every Room of the House keeps its weather; its stairs keep count.",
            location: "Part 1",
            note: "Imported from the current Kobo library.",
            differs: true,
            resetToken: "a".repeat(64),
          };
        },
        resetHighlightToSource: async (input: { id: Highlight["id"]; bookId: Book["id"]; expectedRevision: number }) => {
          const current = previewContents.highlights.find((highlight) => highlight.id === input.id && highlight.bookId === input.bookId);
          if (!current || current.revision !== input.expectedRevision) throw new Error("Passage changed elsewhere");
          const importedNote = current.notes.find(({ origin }) => origin === "import");
          const updated = {
            ...current,
            text: "Every Room of the House keeps its weather; its stairs keep count.",
            sourceLocation: "Part 1",
            notes: importedNote ? current.notes.map((note) => note.id === importedNote.id
              ? { ...note, markdown: "Imported from the current Kobo library.", updatedAt: Date.now(), revision: note.revision + 1 }
              : note) : current.notes,
            updatedAt: Date.now(),
            revision: current.revision + 1,
          } satisfies Highlight;
          previewContents = { ...previewContents, highlights: previewContents.highlights.map((highlight) => highlight.id === input.id ? updated : highlight) };
          return updated;
        },
        setBookArchived: async (input: { id: Book["id"]; archived: boolean; expectedRevision: number }) => {
          const updatedAt = Date.now();
          const changed = changePreviewBook(input.id, (book) => ({ ...book, archived: input.archived, revision: book.revision + 1, updatedAt }));
          return { bookId: input.id, archived: input.archived, revision: changed.revision, updatedAt };
        },
        listReadingStatusHistory: async (id: Book["id"]) => ({
          events: id === previewBook.id ? [...previewStatusHistory].reverse() : [],
          hasMore: false,
        }),
        setBookReadingStatus: async (input: { id: Book["id"]; status: Book["status"]; expectedRevision: number }) => {
          if (input.id !== previewBook.id || previewBook.archived || input.expectedRevision !== previewBook.revision) {
            throw new Error("Book changed elsewhere or no longer exists");
          }
          if (input.status === previewBook.status) return { changed: false, book: previewBook };
          const changedAt = Date.now();
          const completedOn = input.status === "finished" ? new Date(changedAt).toISOString().slice(0, 10) : undefined;
          previewBook = { ...previewBook, status: input.status, ...(completedOn ? { completedOn } : { completedOn: undefined }), revision: previewBook.revision + 1, updatedAt: changedAt };
          previewContents = { ...previewContents, book: previewBook };
          const event = { id: crypto.randomUUID() as never, bookId: input.id, status: input.status, source: "reader" as const, changedAt, ...(completedOn ? { completedOn } : {}), bookRevision: previewBook.revision } satisfies ReadingStatusEvent;
          previewStatusHistory = [...previewStatusHistory, event];
          return { changed: true, book: previewBook, event };
        },
        setBookCompletionDate: async (input: { id: Book["id"]; completedOn?: string; expectedRevision: number }) => {
          if (input.id !== previewBook.id || previewBook.archived || previewBook.status !== "finished" || input.expectedRevision !== previewBook.revision) {
            throw new Error("Book changed elsewhere or is not finished");
          }
          if (input.completedOn === previewBook.completedOn) return previewBook;
          previewBook = { ...previewBook, completedOn: input.completedOn, revision: previewBook.revision + 1, updatedAt: Date.now() };
          previewContents = { ...previewContents, book: previewBook };
          return previewBook;
        },
        mergeBooks: async (input: { sourceBookId: Book["id"]; targetBookId: Book["id"]; expectedSourceRevision: number; expectedTargetRevision: number }) => {
          const updatedAt = Date.now();
          previewBook = { ...previewBook, archived: true, revision: previewBook.revision + 1, updatedAt };
          targetBook = { ...targetBook, highlightCount: targetBook.highlightCount + previewContents.highlights.length, revision: targetBook.revision + 1, updatedAt };
          previewContents = { ...previewContents, book: previewBook };
          return { sourceBookId: input.sourceBookId, targetBookId: input.targetBookId, highlightsMoved: previewContents.highlights.length, notesMoved: previewContents.standaloneNotes.length + previewContents.highlights.reduce((total, highlight) => total + highlight.notes.length, 0), sourceRevision: previewBook.revision, targetRevision: targetBook.revision };
        },
      }),
      covers: Object.freeze({
        resolve: async (sourceUrl: string) => ({ url: sourceUrl, accent: "rgb(235 111 146)" }),
        cancel: async () => undefined,
      }),
      organization: Object.freeze({
        listCollections: async () => previewCollections,
        listTags: async () => previewTags,
        getBook: async (id: Book["id"]) => id === previewBook.id ? previewOrganization : { bookId: id, collectionIds: [], tagIds: [], highlightTags: [] },
        createCollection: async (input: { name: string; description?: string }) => {
          const item = { id: crypto.randomUUID() as never, name: input.name.trim(), ...(input.description ? { description: input.description.trim() } : {}), bookCount: 0, createdAt: Date.now(), updatedAt: Date.now(), revision: 1 } satisfies Collection;
          previewCollections = [...previewCollections, item];
          return item;
        },
        updateCollection: async (input: { id: Collection["id"]; name: string; description?: string }) => {
          const current = previewCollections.find((item) => item.id === input.id)!;
          const item = { ...current, name: input.name.trim(), ...(input.description ? { description: input.description.trim() } : {}), updatedAt: Date.now(), revision: current.revision + 1 } satisfies Collection;
          previewCollections = previewCollections.map((candidate) => candidate.id === item.id ? item : candidate);
          return item;
        },
        deleteCollection: async (input: { id: Collection["id"] }) => { previewCollections = previewCollections.filter((item) => item.id !== input.id); },
        createTag: async (input: { name: string; color?: string }) => {
          const item = { id: crypto.randomUUID() as never, name: input.name.trim(), ...(input.color ? { color: input.color.trim() } : {}), bookCount: 0, highlightCount: 0, createdAt: Date.now(), updatedAt: Date.now(), revision: 1 } satisfies Tag;
          previewTags = [...previewTags, item];
          return item;
        },
        updateTag: async (input: { id: Tag["id"]; name: string; color?: string }) => {
          const current = previewTags.find((item) => item.id === input.id)!;
          const item = { ...current, name: input.name.trim(), ...(input.color ? { color: input.color.trim() } : {}), updatedAt: Date.now(), revision: current.revision + 1 } satisfies Tag;
          previewTags = previewTags.map((candidate) => candidate.id === item.id ? item : candidate);
          return item;
        },
        deleteTag: async (input: { id: Tag["id"] }) => { previewTags = previewTags.filter((item) => item.id !== input.id); },
        setBookCollection: async (input: { bookId: Book["id"]; collectionId: Collection["id"]; included: boolean }) => previewOrganization = { ...previewOrganization, collectionIds: input.included ? [...new Set([...previewOrganization.collectionIds, input.collectionId])] : previewOrganization.collectionIds.filter((id) => id !== input.collectionId) },
        setBookTag: async (input: { bookId: Book["id"]; tagId: Tag["id"]; included: boolean }) => previewOrganization = { ...previewOrganization, tagIds: input.included ? [...new Set([...previewOrganization.tagIds, input.tagId])] : previewOrganization.tagIds.filter((id) => id !== input.tagId) },
        setHighlightTag: async (input: { highlightId: Highlight["id"]; tagId: Tag["id"]; included: boolean }) => {
          const current = previewOrganization.highlightTags.find((entry) => entry.highlightId === input.highlightId)?.tagIds ?? [];
          const tagIds = input.included ? [...new Set([...current, input.tagId])] : current.filter((id) => id !== input.tagId);
          previewOrganization = { ...previewOrganization, highlightTags: [...previewOrganization.highlightTags.filter((entry) => entry.highlightId !== input.highlightId), { highlightId: input.highlightId, tagIds }] };
          return previewOrganization;
        },
      }),
      threads: Object.freeze({
        list: async () => previewThreads,
        get: async (id: Thread["id"]) => {
          const thread = previewThreads.find((item) => item.id === id);
          return thread ? { thread, passages: previewMembership.includes(id) ? [{ highlightId: previewContents.highlights[0]!.id, bookId: previewBook.id, bookTitle: previewBook.title, authors: previewBook.authors, text: previewContents.highlights[0]!.text, notes: previewContents.highlights[0]!.notes, addedAt: now }] : [] } : undefined;
        },
        getHighlightMembership: async () => previewMembership,
        create: async (input: { name: string; description?: string }) => {
          const thread = {
          id: crypto.randomUUID() as never,
          name: input.name.trim(),
          ...(input.description ? { description: input.description.trim() } : {}),
          passageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: 1,
          } satisfies Thread;
          previewThreads = [...previewThreads, thread];
          return thread;
        },
        update: async (input: { id: never; name: string; description?: string; expectedRevision: number }) => ({
          id: input.id,
          name: input.name.trim(),
          ...(input.description ? { description: input.description.trim() } : {}),
          passageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: input.expectedRevision + 1,
        }),
        delete: async (input: { id: Thread["id"] }) => { previewThreads = previewThreads.filter((thread) => thread.id !== input.id); },
        setHighlightMembership: async (input: { bookId: never; highlightId: never; threadIds: readonly never[]; expectedHighlightRevision: number }) => {
          previewMembership = [...input.threadIds];
          return {
          changed: true,
          bookId: input.bookId,
          highlightId: input.highlightId,
          highlightRevision: input.expectedHighlightRevision + 1,
          threadIds: input.threadIds,
          };
        },
      }),
      daily: Object.freeze({
        get: async () => previewDaily,
        ensure: async () => previewDaily,
      }),
      imports: Object.freeze({
        // ?reader shows a plugged-in Kobo, as the import page and the palette offer it.
        listReaders: async () => previewQuery.has("reader") ? [{ id: "a".repeat(32), kind: "kobo" as const, label: "KOBOeReader" }] : [],
        chooseReader: async () => undefined,
        chooseFolder: async () => undefined,
        onReadersChanged: () => () => undefined,
        chooseFile: async () => ({
          token: crypto.randomUUID(),
          fileName: "KoboReader.sqlite",
          provider: "kobo" as const,
          sourceProfiles: [{
            id: "918eb58a-f9c1-4e4a-8d93-a773087c2674",
            provider: "kobo" as const,
            name: "Kobo Clara",
            lastImportedAt: Date.now() - 86_400_000,
          }],
          newSourceId: "9b3b2cca-0e42-4423-ae4e-c1318247095c",
          suggestedSourceId: "918eb58a-f9c1-4e4a-8d93-a773087c2674",
          suggestedSourceName: "Kobo — KoboReader",
          preview: {
            document: {
              formatVersion: 1 as const,
              books: [{ providerRecordId: "preview-book", title: "Piranesi", authors: ["Susanna Clarke"] }],
              annotations: [{ providerRecordId: "preview-highlight", bookProviderRecordId: "preview-book", text: "Every room of the House keeps its weather." }],
            },
            warnings: [],
          },
        }),
        commit: async () => ({
          booksCreated: 0,
          booksReused: 0,
          highlightsCreated: 0,
          annotationsUpdated: 0,
          notesCreated: 0,
          conflictsCreated: 1,
        }),
        listConflicts: async () => [{
          id: "78f05c4d-699a-4aeb-b9c1-8e7e753e40a4" as never,
          sourceName: "Kobo Clara",
          bookTitle: "Piranesi",
          kind: "highlight" as const,
          base: { providerRecordId: "highlight", bookProviderRecordId: "book", text: "Every room of the House keeps its weather.", location: "Entry 7" },
          local: { providerRecordId: "highlight", bookProviderRecordId: "book", text: "Every Room of the House keeps its weather; its stairs keep count.", location: "Entry 7", note: "Keep this wording." },
          incoming: { providerRecordId: "highlight", bookProviderRecordId: "book", text: "Every room of the House forgets nothing.", location: "Entry 8" },
          createdAt: Date.now(),
        }],
        resolveConflict: async () => undefined,
      }),
      sync: Object.freeze({
        // Opt in with ?sync-conflicts so the committed visual baselines keep a quiet bell.
        listConflicts: async () => ({ conflicts: previewSyncConflicts, total: previewSyncConflicts.length }),
        resolveConflict: async (input: { readonly id: string }) => {
          previewSyncConflicts = previewSyncConflicts.filter((conflict) => conflict.id !== input.id);
        },
        run: async () => ({ status: "complete" as const, bootstrapped: 0, pushed: 2, superseded: 0, pulled: 1 }),
        // No provider in the preview, so the header keeps its local-only state.
        status: async () => ({ state: "off" as const }),
        onStatus: () => () => undefined,
      }),
      exports: Object.freeze({
        create: async () => ({ fileName: "Leaflogue-library-preview.json", booksExported: 2, highlightsExported: 1, notesExported: 1 }),
        createMarkdown: async () => ({ folderName: "Leaflogue Markdown preview", booksExported: 2, highlightsExported: 1, notesExported: 1 }),
      }),
      backups: Object.freeze({
        create: async () => ({ fileName: "Leaflogue-backup.sqlite" }),
        restore: async () => ({
          fileName: "Leaflogue-backup.sqlite",
          booksRestored: 1,
          databaseSchemaVersion: 3,
        }),
      }),
      remote: Object.freeze({
        describe: async () => previewRemoteConfig,
        save: async (input: { provider: "postgres"; databaseUrl: string; location: "default" | "choose" } | { provider: "convex"; deploymentUrl: string; syncKey?: string; location: "default" | "choose" }) => {
          previewRemoteConfig = input.provider === "postgres" ? {
            configured: true, provider: "postgres", source: "config", host: "saved.example.test",
            database: "leaflogue", transport: "tls",
          } : {
            configured: true, provider: "convex", source: "config", host: "quiet-otter-123.convex.cloud",
            deployment: "quiet-otter-123", transport: "tls",
            syncKeySaved: Boolean(input.syncKey) || Boolean(previewRemoteConfig.provider === "convex" && previewRemoteConfig.syncKeySaved),
          };
          return previewRemoteConfig;
        },
        check: async () => previewRemoteConfig.configured ? ({
          ...previewRemoteConfig,
          reachable: true,
          initialized: previewRemoteConfig.provider === "convex",
          ...(previewRemoteConfig.provider === "convex" ? { schemaVersion: 17 } : {}),
        }) : ({ configured: false, reachable: false, initialized: false, problem: "Save a connection before checking it." }),
        initialize: async () => ({
          ...previewRemoteConfig,
          reachable: true,
          initialized: true,
          schemaVersion: 1,
        }),
      }),
      ai: Object.freeze({
        describe: async () => previewAiConfig,
        acceptTerms: async (providerId: string) => {
          previewAiConfig = { ...previewAiConfig, providers: previewAiConfig.providers.map((provider) => provider.id === providerId ? { ...provider, consented: true } : provider) };
          return previewAiConfig;
        },
        describeExplainTask: async (_bookId: never, highlightId: never, includeNotes: boolean) => {
          const passage = previewContents.highlights.find(({ id }) => id === highlightId);
          const provider = previewAiConfig.providers.find(({ id }) => id === previewAiConfig.selectedProvider)!;
          return {
            providerId: provider.id,
            providerName: provider.id === "anthropic" ? "Anthropic" : provider.id,
            model: provider.selectedModel,
            trainsOnFreeTier: provider.id === "gemini",
            consented: provider.consented,
            bookTitle: previewBook.title,
            authors: previewBook.authors,
            ...(previewBook.description ? { description: previewBook.description } : {}),
            passage: passage?.text ?? "",
            notes: includeNotes ? (passage?.notes ?? []).map(({ markdown }) => markdown) : [],
          };
        },
        explainPassage: async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return {
            providerId: "anthropic",
            model: "claude-sonnet",
            explanation: "The narrator treats the House as a **living presence**, not merely a setting. Its vastness matters because every room asks for care and attention.\n\nThe passage also turns observation into a kind of friendship. The tides and statues are not clues to solve and discard; they are things the narrator learns to live alongside. That patient attention makes the House feel less like a maze and more like a home.\n\nEven so, the warmth is uneasy. A place that provides shelter can also limit what its inhabitant knows about the world beyond it. The passage invites the reader to hold both feelings at once: gratitude for the House and curiosity about what it may conceal.",
          };
        },
        cancel: async () => undefined,
        save: async (input: AiSettingsInput) => {
          previewAiConfig = {
            enabled: input.enabled,
            selectedProvider: input.selectedProvider,
            providers: previewAiConfig.providers.map((provider) => provider.id === input.selectedProvider ? {
              ...provider,
              selectedModel: input.selectedModel,
              credential: input.clearSavedApiKey ? "missing" : input.apiKey ? "saved" : provider.credential,
            } : provider),
          };
          return previewAiConfig;
        },
      }),
      appearance: Object.freeze({
        describe: async () => previewAppearance,
        save: async (input: AppearanceSettingsInput) => {
          previewAppearance = appearanceConfiguration(input);
          return previewAppearance;
        },
        exportTheme: async (themeId: string) => ({ fileName: `${themeId}-custom.json`, themeName: `${previewAppearance.themes.find(({ id }) => id === themeId)?.name ?? themeId} custom` }),
        importTheme: async () => undefined,
        openThemesFolder: async () => "~/.config/leaflogue/themes",
        onChanged: () => () => undefined,
      }),
      statistics: Object.freeze({
        get: async () => ({
          totals: { books: 2, reading: 1, finished: 1, highlights: 14, notes: 6, threads: 1 },
          finishedByYear: [{ year: 2024, books: 3 }, { year: 2025, books: 7 }, { year: 2026, books: 4 }],
          highlightsByMonth: ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]
            .map((month, index) => ({ month, highlights: [2, 0, 5, 3, 1, 0, 4, 8, 2, 6, 3, 1][index]! })),
          topBooks: [{ bookId: previewBook.id, title: previewBook.title, highlights: 9 }],
          topAuthors: [{ name: "Susanna Clarke", highlights: 478, books: 2 }],
          // A plausible three months of reading, so the overview has something to draw.
          days: Array.from({ length: 68 }, (_, index) => {
            const date = new Date(2026, 6, 20 + index);
            const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            return { day, highlights: (index * 37 + 11) % 9 === 0 ? 0 : ((index * 53) % 41) + 1 };
          }).filter(({ highlights }) => highlights > 0),
          books: [
            { bookId: previewBook.id, title: previewBook.title, authors: previewBook.authors, status: previewBook.status, highlights: 292, notes: 17, activeDays: 4, averageLength: 403, firstDay: "2026-08-31", lastDay: "2026-09-03" },
            { bookId: targetBook.id, title: targetBook.title, authors: targetBook.authors, status: targetBook.status, highlights: 186, notes: 5, activeDays: 10, averageLength: 260, firstDay: "2026-07-20", lastDay: "2026-08-02" },
          ],
          series: [{ name: "The Heroes of Olympus", books: 4, finished: 4, highlights: 178 }],
          lengths: [199, 730, 587, 334] as const,
          averageLength: 403,
          highlightsWithNotes: 6,
          longestLength: 5193,
          coverage: { highlightsDated: 14, booksWithSeries: 1, finishedDated: 1 },
          hours: [0, 0, 0, 0, 0, 0, 1, 3, 2, 1, 0, 0, 1, 2, 0, 0, 1, 2, 3, 5, 8, 11, 9, 4],
          onThisDay: [
            { highlightId: "00000000-0000-4000-8000-0000000000a1" as never, bookId: previewBook.id, title: previewBook.title, text: "The quiet rooms held a different kind of weather.", day: `${new Date().getFullYear() - 1}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}` },
          ],
          recent: [
            { highlightId: "00000000-0000-4000-8000-0000000000a2" as never, bookId: targetBook.id, title: targetBook.title, text: "I realised that the search for the Knowledge had encouraged us to think of the House as if it were a sort of riddle to be unravelled.", day: "2026-09-25" },
            { highlightId: "00000000-0000-4000-8000-0000000000a3" as never, bookId: previewBook.id, title: previewBook.title, text: "I am the Beloved Child of the House.", day: "2026-09-24" },
          ],
          inProgress: [
            { bookId: previewBook.id, title: previewBook.title, authors: previewBook.authors, status: "reading" as const, highlights: 292, lastDay: "2026-09-03", latest: { highlightId: "00000000-0000-4000-8000-0000000000a3" as never, bookId: previewBook.id, title: previewBook.title, text: "I am the Beloved Child of the House.", day: "2026-09-03" } },
            { bookId: targetBook.id, title: targetBook.title, authors: targetBook.authors, status: "paused" as const, highlights: 186, lastDay: "2026-08-02" },
          ],
        }),
      }),
      dashboards: Object.freeze({
        describe: async () => previewDashboards,
        save: async (dashboard: DashboardId, layout: readonly DashboardPlacement[] | null) => {
          const next: { -readonly [K in DashboardId]?: readonly DashboardPlacement[] } = { ...previewDashboards };
          if (layout) next[dashboard] = layout;
          else delete next[dashboard];
          previewDashboards = next;
          return previewDashboards;
        },
      }),
      widgets: previewWidgetsBridge({ get: () => previewDashboards, set: (next) => { previewDashboards = next; } }),
      updates: Object.freeze({
        check: async () => ({ state: "unavailable" as const, reason: "development" as const, currentVersion: "0.0.0-preview" }),
        install: async () => undefined,
        describe: async () => ({ automaticCheck: previewAutomaticUpdates }),
        setAutomaticCheck: async (enabled: boolean) => {
          previewAutomaticUpdates = enabled;
          return { automaticCheck: enabled };
        },
        onAvailable: () => () => undefined,
      }),
    }),
  });
}
