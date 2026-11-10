import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./confirm.module.css";

export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  /** Marks an action that cannot be undone, so the button reads as a warning. */
  readonly destructive?: boolean;
}

interface Pending extends ConfirmRequest {
  readonly settle: (confirmed: boolean) => void;
}

/**
 * An in-app replacement for `window.confirm`: `await confirm({...})` resolves
 * true or false, and the returned node must be rendered by the caller.
 */
export function useConfirm(): readonly [(request: ConfirmRequest) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => {
    const opener = document.activeElement;
    setPending({
      ...request,
      settle: (confirmed) => {
        setPending(null);
        resolve(confirmed);
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      },
    });
  }), []);
  return [confirm, pending && <ConfirmDialog request={pending} />];
}

function ConfirmDialog({ request }: { readonly request: Pending }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`ll-dialog ${styles.dialog}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-message`}
      onCancel={(event) => { event.preventDefault(); request.settle(false); }}
      onClick={(event) => { if (event.target === event.currentTarget) request.settle(false); }}
    >
      <h2 id={`${id}-title`}>{request.title}</h2>
      <p id={`${id}-message`}>{request.message}</p>
      <div className={styles.actions}>
        <button type="button" className="ll-button-secondary" autoFocus onClick={() => request.settle(false)}>Cancel</button>
        <button type="button" className={`ll-button ${request.destructive ? styles.destructive : ""}`} onClick={() => request.settle(true)}>{request.confirmLabel}</button>
      </div>
    </dialog>
  );
}
