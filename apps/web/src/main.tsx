import "@leaflogue/ui/ui.css";
import "@leaflogue/renderer/styles.css";
import "./web.css";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { LeaflogueBridge } from "@leaflogue/contracts";
import { startLeaflogue } from "@leaflogue/renderer/boot";
import { createWebBridge } from "./bridge/web-bridge";
import { ConvexEntry } from "./ConvexApp";
import { loadWebConfig } from "./config";
import { serverSession } from "./session/server";
import { SignIn, StartFailed } from "./SignIn";
import { BackendError } from "./transport/transport";
import { serverTransport } from "./transport/server";

function show(root: HTMLElement, page: ReactNode): void {
  createRoot(root).render(<StrictMode>{page}</StrictMode>);
}

function install(bridge: LeaflogueBridge): void {
  Object.defineProperty(window, "leaflogue", { configurable: false, writable: false, value: Object.freeze(bridge) });
}

async function main(root: HTMLElement): Promise<void> {
  const config = await loadWebConfig();
  if (config.backend === "convex") return show(root, <ConvexEntry install={install} />);
  const session = await serverSession();
  if (!session.signedIn) {
    const error = new URLSearchParams(window.location.search).get("sign_in_error") ?? undefined;
    return show(root, <SignIn onSignIn={() => session.signIn()} {...(error ? { error } : {})} />);
  }
  const transport = serverTransport();
  const [library] = await transport.query<{ libraryId: string }[]>("access:myLibraries", {});
  if (!library) throw new Error("Your account has no library on this server yet. Ask whoever runs it to add you.");
  install(createWebBridge({
    transport,
    libraryId: library.libraryId,
    host: { kind: "web", backend: "server", ...(session.email ? { account: session.email } : {}) },
    signOut: () => session.signOut(),
  }));
  await startLeaflogue(root);
}

const root = document.getElementById("root")!;
main(root).catch((error: unknown) => {
  show(root, <StartFailed message={error instanceof BackendError || error instanceof Error ? error.message : "Something went wrong while opening Leaflogue."} />);
});
