/** Refuse redirects, origin changes, and bodies beyond `maximumBytes` before Convex parses them. */
export async function readBoundedConvexResponse(response: Response, expectedOrigin: string, maximumBytes: number): Promise<Response> {
  if (response.redirected || (response.url && new URL(response.url).origin !== expectedOrigin)) {
    throw new Error("Convex response origin changed");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new Error("Convex response is too large");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("Convex response is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(total === 0 ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function validateConvexDeploymentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Convex deployment URL is invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!url.hostname || (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("Convex deployment URL must be credential-free HTTPS, except loopback development");
  }
  return url.toString().replace(/\/$/u, "");
}
