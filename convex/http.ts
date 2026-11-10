import { httpRouter } from "convex/server";
import { auth } from "./auth";

/** The web app's sign-in routes. A host app keeps its own http.ts. */
const http = httpRouter();
auth.addHttpRoutes(http);
export default http;
