import { useEffect, useState } from "react";
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import type { LeaflogueBridge } from "@leaflogue/contracts";
import { App } from "@leaflogue/renderer/App";
import { activateStoredAppearance } from "@leaflogue/renderer/appearance";
import { createWebBridge } from "./bridge/web-bridge";
import { checkDeployment, normalizeDeployment, savedDeployment } from "./deployment";
import { ChooseDeployment, SignIn, StartFailed } from "./SignIn";
import { convexTransport } from "./transport/convex";

type Install = (bridge: LeaflogueBridge) => void;

/**
 * The web app on Convex: the reader names their deployment (kept in this
 * browser), then signs in to it. No host decides whose library opens.
 */
export function ConvexEntry({ install }: { readonly install: Install }) {
  const [deployment, setDeployment] = useState(() => savedDeployment.get());
  if (!deployment) {
    return <ChooseDeployment onChoose={async (input) => {
      const url = normalizeDeployment(input);
      if (!url) throw new Error("Enter the deployment's https address, such as https://quiet-otter-123.convex.cloud.");
      await checkDeployment(url);
      savedDeployment.set(url);
      setDeployment(url);
    }} />;
  }
  const change = () => { savedDeployment.forget(); setDeployment(undefined); };
  return <ConvexApp key={deployment} convexUrl={deployment} install={install} onChangeDeployment={change} />;
}

/**
 * One Convex deployment. Convex Auth keeps the reader signed in
 * (and refreshes their token) for as long as this tree is mounted, so the
 * library renders inside it rather than in a root of its own.
 */
function ConvexApp({ convexUrl, install, onChangeDeployment }: { readonly convexUrl: string; readonly install: Install; readonly onChangeDeployment: () => void }) {
  const [client] = useState(() => new ConvexReactClient(convexUrl));
  return (
    <ConvexAuthProvider client={client}>
      <Gate client={client} convexUrl={convexUrl} install={install} onChangeDeployment={onChangeDeployment} />
    </ConvexAuthProvider>
  );
}

type Opening = { readonly state: "opening" } | { readonly state: "open" } | { readonly state: "failed"; readonly message: string };

function Gate({ client, convexUrl, install, onChangeDeployment }: {
  readonly client: ConvexReactClient;
  readonly convexUrl: string;
  readonly install: Install;
  readonly onChangeDeployment: () => void;
}) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn, signOut } = useAuthActions();
  const [opening, setOpening] = useState<Opening>({ state: "opening" });

  useEffect(() => {
    if (!isAuthenticated || opening.state !== "opening") return;
    let active = true;
    void (async () => {
      const transport = convexTransport(client);
      try {
        const [library] = await transport.query<{ libraryId: string }[]>("access:myLibraries", {});
        if (!library) throw new Error("Your account has no library on this deployment yet. Sign out and in again, or ask whoever runs it to add you.");
        // A host without the standalone account query still opens; the panel just shows no email.
        const account = await transport.query<{ email?: string } | null>("auth:account", {}).catch(() => null);
        install(createWebBridge({
          transport,
          libraryId: library.libraryId,
          host: { kind: "web", backend: "convex", deployment: convexUrl, ...(account?.email ? { account: account.email } : {}) },
          signOut: async () => { await signOut(); window.location.assign("/"); },
          changeDeployment: async () => { await signOut(); savedDeployment.forget(); window.location.assign("/"); },
        }));
        await activateStoredAppearance(() => window.leaflogue.appearance.describe());
        if (active) setOpening({ state: "open" });
      } catch (error) {
        if (active) setOpening({ state: "failed", message: error instanceof Error ? error.message : "Leaflogue could not open your library." });
      }
    })();
    return () => { active = false; };
  }, [client, convexUrl, install, isAuthenticated, opening.state, signOut]);

  if (isLoading) return null;
  if (!isAuthenticated) return <SignIn deployment={convexUrl} onSignIn={() => void signIn("google")} onChangeDeployment={onChangeDeployment} />;
  if (opening.state === "failed") return <StartFailed message={opening.message} />;
  return opening.state === "open" ? <App /> : null;
}
