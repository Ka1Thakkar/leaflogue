import { PGlite } from "@electric-sql/pglite";
import { readConfig } from "./config";
import { createLeaflogueServer } from "./http";
import { pgliteDatabase } from "./pglite";
import { prepareDatabase } from "./web-schema";

/**
 * A throwaway server for development and the web smoke test: PostgreSQL in
 * memory (or in LEAFLOGUE_DEV_DATA, a folder), no sign-in, this computer only.
 */
const port = process.env.PORT ?? "8787";
const config = readConfig({
  LEAFLOGUE_PUBLIC_URL: `http://localhost:${port}`,
  ...process.env,
  DATABASE_URL: "pglite://local",
  LEAFLOGUE_AUTH: "none",
  HOST: "127.0.0.1",
  PORT: port,
});
const database = pgliteDatabase(new PGlite(process.env.LEAFLOGUE_DEV_DATA));
await prepareDatabase(database);
createLeaflogueServer({ config, database }).listen(config.port, config.host, () => {
  console.log(`Leaflogue dev server on ${config.publicUrl.origin}, without sign-in${config.webRoot ? `, serving ${config.webRoot}` : ""}`);
});
