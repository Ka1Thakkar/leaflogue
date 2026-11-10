const sharedPolicy = "style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: leaflogue:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Vite injects the React-refresh preamble as an inline module in development.
 * That local-only page also needs eval for source transforms and a loopback
 * websocket for HMR. Packaged builds retain a default-deny script and network
 * policy and must never inherit these development exceptions.
 */
export function rendererContentPolicy(development: boolean): string {
  return development
    ? `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; ${sharedPolicy}; connect-src 'self' ws://localhost:* http://localhost:*`
    : `default-src 'self'; script-src 'self'; ${sharedPolicy}; connect-src 'none'`;
}

export function validateDevelopmentRendererUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password) {
    throw new Error("The development renderer URL must be an unauthenticated loopback HTTP URL");
  }
  return url.href;
}

export function rendererContentPolicyForRequest(
  packaged: boolean,
  developmentUrl: string | undefined,
  requestUrl: string,
): string {
  const developmentOrigin = developmentUrl ? new URL(developmentUrl).origin : undefined;
  const requestOrigin = new URL(requestUrl).origin;
  return rendererContentPolicy(!packaged && developmentOrigin !== undefined && requestOrigin === developmentOrigin);
}
