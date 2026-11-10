import type { WebSession } from "./session";

/** apps/server keeps the session in an HttpOnly cookie; the page only asks whether it exists. */
export async function serverSession(fetchImplementation: typeof fetch = (input, init) => fetch(input, init)): Promise<WebSession> {
  const response = await fetchImplementation("/api/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Leaflogue could not check whether you are signed in.");
  const body = await response.json() as { signedIn?: boolean; email?: string };
  return {
    signedIn: body.signedIn === true,
    ...(typeof body.email === "string" ? { email: body.email } : {}),
    signIn: () => { window.location.assign("/auth/sign-in"); },
    signOut: async () => {
      const result = await fetchImplementation("/auth/sign-out", { method: "POST", credentials: "same-origin" });
      if (!result.ok) throw new Error("Leaflogue could not sign you out.");
      window.location.assign("/");
    },
  };
}
