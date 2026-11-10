import type { PGlite } from "@electric-sql/pglite";
import type { PostgresClient } from "@leaflogue/remote";
import type { Database } from "./database";

/**
 * PostgreSQL in-process, for tests and for a throwaway local server
 * (`npm run dev:local`). Never used by the production entry point.
 */

export function pgliteClient(database: PGlite): PostgresClient {
  return {
    async connect() {},
    async end() {},
    async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      if (values && values.length > 0) return { rows: (await database.query<Row>(text, [...values])).rows };
      const results = await database.exec(text);
      return { rows: (results.at(-1)?.rows ?? []) as Row[] };
    },
  };
}

/** PGlite is one connection, so requests take turns, as they would with a pool of one. */
export function pgliteDatabase(database: PGlite): Database {
  const client = pgliteClient(database);
  let tail = Promise.resolve();
  return {
    async withClient(operation) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await operation(client);
      } finally {
        release();
      }
    },
    async close() {},
  };
}
