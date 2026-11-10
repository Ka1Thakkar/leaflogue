import { ConfigError, readConfig } from "./config";
import { poolDatabase } from "./database";
import { createLeaflogueServer } from "./http";
import { prepareDatabase, SchemaError } from "./web-schema";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const database = poolDatabase(config.databaseUrl);
  await prepareDatabase(database);
  const server = createLeaflogueServer({ config, database });
  server.listen(config.port, config.host, () => {
    console.log(`Leaflogue server listening on ${config.host}:${config.port} for ${config.publicUrl.origin}`);
  });
  const stop = () => {
    server.close(() => void database.close().finally(() => process.exit(0)));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof SchemaError) console.error(error.message);
  else console.error("The Leaflogue server could not start", error);
  process.exit(1);
});
