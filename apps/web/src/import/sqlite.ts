import type { Database, SqlValue } from "sql.js";
import type { ReadonlyDatabase } from "@leaflogue/importers";

/** sql.js behind the read-only database interface Leaflogue's importers use. */
export function readonlyDatabase(database: Database): ReadonlyDatabase {
  return {
    prepare(sql) {
      function* iterate(...parameters: readonly unknown[]): Generator<Record<string, unknown>> {
        const statement = database.prepare(sql);
        try {
          statement.bind(parameters as SqlValue[]);
          while (statement.step()) yield statement.getAsObject();
        } finally {
          statement.free();
        }
      }
      return {
        all: (...parameters) => [...iterate(...parameters)],
        get: (...parameters) => {
          for (const row of iterate(...parameters)) return row;
          return undefined;
        },
        iterate,
      };
    },
  };
}
