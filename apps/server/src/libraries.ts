import { randomUUID } from "node:crypto";
import type { PostgresClient } from "@leaflogue/remote";
import { accessDenied, ServerError } from "./errors";

export type LibraryRole = "owner" | "editor" | "viewer";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Make a signed-in reader an owner of the library this server serves,
 * creating it if the database has none yet. Like the Convex host, a server
 * serves one library: with several, LEAFLOGUE_LIBRARY_ID chooses it. Who may
 * get here at all is decided earlier, by the email allowlist.
 */
export async function provisionOwner(client: PostgresClient, userId: string, configuredLibraryId?: string): Promise<string> {
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1279671369)");
    let libraryId = configuredLibraryId;
    if (libraryId) {
      await client.query("INSERT INTO leaflogue.libraries (id, name) VALUES ($1, 'My library') ON CONFLICT (id) DO NOTHING", [libraryId]);
    } else {
      const libraries = await client.query<{ id: string }>("SELECT id::text AS id FROM leaflogue.libraries ORDER BY created_at LIMIT 2", []);
      if (libraries.rows.length > 1) {
        throw new ServerError("LEAFLOGUE_LIBRARY_SELECTION_REQUIRED", "This database holds more than one library. Set LEAFLOGUE_LIBRARY_ID on the server.", 409);
      }
      libraryId = libraries.rows[0]?.id;
      if (!libraryId) {
        libraryId = randomUUID();
        await client.query("INSERT INTO leaflogue.libraries (id, name) VALUES ($1, 'My library')", [libraryId]);
      }
    }
    await client.query(`
      INSERT INTO leaflogue_web.library_members (library_id, user_id, role) VALUES ($1, $2, 'owner')
      ON CONFLICT (library_id, user_id) DO UPDATE SET role = 'owner'
    `, [libraryId, userId]);
    await client.query("COMMIT");
    return libraryId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function requireLibraryAccess(client: PostgresClient, userId: string, libraryId: string, permission: "read" | "write"): Promise<LibraryRole> {
  if (!UUID.test(libraryId)) throw accessDenied();
  const membership = await client.query<{ role: LibraryRole }>(
    "SELECT role FROM leaflogue_web.library_members WHERE library_id = $1 AND user_id = $2",
    [libraryId, userId],
  );
  const role = membership.rows[0]?.role;
  if (!role || (permission === "write" && role === "viewer")) throw accessDenied();
  return role;
}

export async function myLibraries(client: PostgresClient, userId: string): Promise<{ libraryId: string; role: LibraryRole }[]> {
  const memberships = await client.query<{ library_id: string; role: LibraryRole }>(
    "SELECT library_id::text AS library_id, role FROM leaflogue_web.library_members WHERE user_id = $1 ORDER BY created_at LIMIT 20",
    [userId],
  );
  return memberships.rows.map((row) => ({ libraryId: row.library_id, role: row.role }));
}
