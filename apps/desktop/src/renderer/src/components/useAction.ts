import { useCallback, useState } from "react";

/**
 * The pending flag and error line shared by an action's buttons. `run` clears
 * the error, awaits the task, and shows `failure` if it throws. It resolves to
 * whether the task succeeded.
 */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (task: () => Promise<void>, failure: string) => {
    setPending(true);
    setError("");
    try {
      await task();
      return true;
    } catch {
      setError(failure);
      return false;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, setPending, error, setError, run };
}
