---
title: Connect an agent with MCP
description: Give a trusted local MCP client read-only access to your Leaflogue library.
---

Leaflogue desktop includes an optional local MCP server. It lets a compatible
agent client search your saved passages, read books and notes, and explore
threads with the source details needed for citations. No AI key or separate
Leaflogue server is needed. This is a desktop feature; the browser app does
not expose your local library through MCP.

## Enable access

1. Install the desktop app in its normal location and open your library once.
   On Mac, move it into Applications before copying the client configuration.
2. Open **Settings → Agent access**, then expand **Local MCP · Agent access**.
3. Read the disclosure and turn on **Enable local MCP access**.
4. Copy **MCP client configuration** into your client's local MCP server settings.
   Merge the `leaflogue` entry into an existing `mcpServers` object if needed;
   do not overwrite your other servers. Clients with a setup form can use the
   same command, arguments, and environment fields separately.
5. Restart or reconnect the MCP client and ask it to list Leaflogue's tools.

The generated configuration points at this installation and this library
profile. It uses **stdio**: the client launches Leaflogue with `--mcp` and
communicates over that process's input/output. There is no web endpoint, open
network port, or MCP password. You can close the desktop window while using
MCP; the client process reads the local library independently.

An illustrative configuration looks like this; use the actual values from
Settings rather than copying this placeholder path:

```json
{
  "mcpServers": {
    "leaflogue": {
      "command": "/path/to/installed/Leaflogue",
      "args": ["--mcp"]
    }
  }
}
```

## What an agent can read

| Tool | Reading data |
| --- | --- |
| `list_books` | Books, optionally filtered by title or author |
| `get_book` | One book's metadata and a page of standalone notes |
| `search_passages` | Saved quotations and their notes, optionally filtered to a book |
| `list_threads` | Thematic threads |
| `get_thread` | A page of a thread's passages and their notes |

Try: “Find my saved passages about attention, and cite the book and location.”
Or: “Compare the passages in my Time thread.”

Passage responses keep the quotation separate from reader and AI notes. They
include book and passage IDs, title, authors, and a source location when one
was imported or saved. Missing locations are not invented. Results are paged
(default 20, maximum 50); long text is marked as truncated, and some note pages
are capped at 20. Text search comes first; this is not semantic search.

The server provides no editing, deletion, import, publishing, shell, SQL,
credential, or arbitrary-file tools. It opens SQLite read-only and does not
migrate the library. If a newer app upgraded your library, use its matching
MCP server rather than an older installation.

## Privacy and disabling

**Local MCP does not mean a connected agent keeps its responses local.** A
cloud-based agent may send the passages and notes it retrieves to its provider.
Review your client's permissions and provider settings before enabling access.
Book text and notes are source material, never instructions for an agent to
follow. Only connect clients you trust.

Turn off **Enable local MCP access** in Settings to block further reading
requests, including from an already connected client. Information already
returned to a client cannot be retracted. Remove the client entry as well if
you no longer want it launching Leaflogue.

MCP reads this computer's current library. Normal library sync remains
separate: MCP does not enable sync, contact a remote database, or upload files.

## Troubleshooting

- **The process exits immediately:** open the desktop app, check that MCP is
  enabled for this profile, and recopy its configuration. Do not add
  `ELECTRON_RUN_AS_NODE`; packaged security fuses deliberately prohibit it.
- **The app moved or was replaced:** copy the configuration again from the
  installed app. Temporary DMG, translocated Mac, and extracted AppImage
  executable paths can disappear; install first. Linux AppImage configurations
  use the original AppImage path rather than its temporary mount.
- **No books appear:** verify the desktop library/profile and the query. An
  unsynced change on another device is not yet in this local library.
- **A response is too large:** reduce `limit` or narrow the search. Use
  `nextOffset` and `hasMore` for further pages.
- **The client expects an HTTP URL:** configure a local stdio server instead.
  This release does not provide a hosted or remotely accessible MCP endpoint.
