import type { PostgresClient } from "@leaflogue/remote";
import pg from "pg";

/**
 * Where requests get a connection. Each request holds one connection for its
 * whole run, because library mutations hold a transaction on it.
 */
export interface Database {
  withClient<Result>(operation: (client: PostgresClient) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

export function poolDatabase(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    application_name: "leaflogue-server",
    max: 10,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
  });
  return {
    async withClient(operation) {
      const connection = await pool.connect();
      const client: PostgresClient = {
        async connect() {},
        async end() {},
        async query(text, values) {
          const result = await connection.query(text, values ? [...values] : undefined);
          // A multi-statement script returns one result per statement.
          const last = Array.isArray(result) ? result.at(-1) as pg.QueryResult | undefined : result;
          return { rows: (last?.rows ?? []) as never[] };
        },
      };
      let broken = false;
      try {
        return await operation(client);
      } catch (error) {
        broken = error instanceof Error && "code" in error && typeof error.code === "string" && /^(08|57)/u.test(error.code);
        throw error;
      } finally {
        connection.release(broken);
      }
    },
    close: () => pool.end(),
  };
}
