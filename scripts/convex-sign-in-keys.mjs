#!/usr/bin/env node
/**
 * Create the keys a Leaflogue Convex deployment signs web-app readers in with
 * (Convex Auth's JWT_PRIVATE_KEY and JWKS) and store them on the deployment.
 * Run it in the backend folder; pass --prod for the production deployment.
 * The keys are never printed. Running it again replaces them, which signs
 * everyone out.
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function signInKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    // Convex Auth stores the PEM on one line, with spaces for its line breaks.
    JWT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString().trimEnd().replace(/\n/gu, " "),
    JWKS: JSON.stringify({ keys: [{ use: "sig", ...publicKey.export({ format: "jwk" }) }] }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = process.argv.slice(2);
  for (const [name, value] of Object.entries(signInKeys())) {
    execFileSync("npx", ["--no-install", "convex", "env", "set", ...options, name, "--", value], { stdio: ["ignore", "inherit", "inherit"] });
  }
}
