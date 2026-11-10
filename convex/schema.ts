import { authTables } from "@convex-dev/auth/server";
import { defineSchema } from "convex/server";
import { leaflogueTables } from "./tables";

/**
 * Leaflogue's deployment schema, with the web app's sign-in tables. A host
 * app replaces this file with its own, spreading `leaflogueTables`.
 */
export default defineSchema({ ...authTables, ...leaflogueTables });
