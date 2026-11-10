import { useId, useState } from "react";
import { Leaf } from "@leaflogue/renderer/components/icons";

const SIGN_IN_ERRORS: Readonly<Record<string, string>> = {
  LEAFLOGUE_ACCESS_DENIED: "That account is not allowed to use this library. Sign in with a verified email address the owner has allowed.",
};

/** The one page a visitor sees before signing in. */
export function SignIn({ onSignIn, error, deployment, onChangeDeployment }: {
  readonly onSignIn: () => void;
  readonly error?: string;
  /** On Convex: whose deployment this signs in to, and the way to pick another. */
  readonly deployment?: string;
  readonly onChangeDeployment?: () => void;
}) {
  const message = error ? SIGN_IN_ERRORS[error] ?? "Signing in did not finish. Try again." : undefined;
  return (
    <main className="ll-web-gate">
      <p className="ll-wordmark"><Leaf size={20} strokeWidth={1.8} aria-hidden="true" />Leaflogue</p>
      <h1 className="ll-title">Your reading library</h1>
      <p className="ll-muted">
        Sign in to see your books, passages, and notes{deployment ? <> on <strong>{new URL(deployment).host}</strong></> : null}.
      </p>
      {message && <p className="ll-inline-error" role="alert">{message}</p>}
      <div className="ll-web-gate-actions">
        <button type="button" className="ll-button" onClick={onSignIn}>{deployment ? "Sign in with Google" : "Sign in"}</button>
        {onChangeDeployment && <button type="button" className="ll-button-secondary" onClick={onChangeDeployment}>Use a different deployment</button>}
      </div>
    </main>
  );
}

/** On Convex, the first visit asks which deployment holds the reader's library. */
export function ChooseDeployment({ onChoose, initial = "" }: {
  readonly onChoose: (input: string) => Promise<void>;
  readonly initial?: string;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className="ll-web-gate">
      <p className="ll-wordmark"><Leaf size={20} strokeWidth={1.8} aria-hidden="true" />Leaflogue</p>
      <h1 className="ll-title">Open your library</h1>
      <p className="ll-muted">Enter the address of the Convex deployment your library is on, the same one Leaflogue on your computer syncs with.</p>
      <form className="ll-web-gate-form" onSubmit={async (event) => {
        event.preventDefault();
        setPending(true); setError("");
        try { await onChoose(value); } catch (cause) { setError(cause instanceof Error ? cause.message : "Leaflogue could not open that deployment."); setPending(false); }
      }}>
        <label className="ll-label" htmlFor={id}>Deployment address</label>
        <input id={id} className="ll-field" type="text" inputMode="url" autoComplete="url" spellCheck={false} required
          placeholder="https://quiet-otter-123.convex.cloud" value={value} onChange={(event) => setValue(event.target.value)} aria-describedby={error ? `${id}-error` : undefined} />
        {error && <p id={`${id}-error`} className="ll-inline-error" role="alert">{error}</p>}
        <button className="ll-button" disabled={pending}>{pending ? "Checking…" : "Continue"}</button>
      </form>
    </main>
  );
}

/** A page that could not start, with what to do about it. */
export function StartFailed({ message }: { readonly message: string }) {
  return (
    <main className="ll-web-gate">
      <p className="ll-wordmark"><Leaf size={20} strokeWidth={1.8} aria-hidden="true" />Leaflogue</p>
      <h1 className="ll-title">Leaflogue could not open</h1>
      <p className="ll-inline-error" role="alert">{message}</p>
      <button type="button" className="ll-button-secondary" onClick={() => window.location.reload()}>Try again</button>
    </main>
  );
}
