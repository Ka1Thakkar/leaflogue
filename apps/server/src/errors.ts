/**
 * A failure the client may see. Codes match the Convex backend's, so a web
 * client handles both backends the same way. Anything else thrown while
 * serving a request is reported without its details.
 */
export class ServerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ServerError";
    this.code = code;
    this.status = status;
  }
}

export const authRequired = () => new ServerError("LEAFLOGUE_AUTH_REQUIRED", "Authentication is required", 401);
export const accessDenied = () => new ServerError("LEAFLOGUE_ACCESS_DENIED", "Library access is denied", 403);
