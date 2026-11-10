import { useEffect, useRef } from "react";

/**
 * A request for a page to do something once it is showing: focus a setting,
 * open its Add book dialog, read a plugged-in reader. If the page is already
 * open it hears the request at once; otherwise the request waits briefly for
 * the page to mount after navigation.
 */
export interface Channel<T> {
  send(value: T): void;
  /** Receive requests while the calling component is mounted. */
  useReceiver(handler: (value: T) => void): void;
}

const WAIT_MS = 5_000;

export function createChannel<T>(): Channel<T> {
  let pending: { readonly value: T; readonly at: number } | undefined;
  const listeners = new Set<(value: T) => void>();
  return {
    send(value) {
      if (listeners.size > 0) {
        pending = undefined;
        for (const listener of listeners) listener(value);
      } else {
        pending = { value, at: Date.now() };
      }
    },
    useReceiver(handler) {
      const latest = useRef(handler);
      useEffect(() => { latest.current = handler; });
      useEffect(() => {
        const listener = (value: T) => latest.current(value);
        listeners.add(listener);
        if (pending) {
          const { value, at } = pending;
          pending = undefined;
          // A request nobody arrived for in time (say, navigation was refused) is dropped.
          if (Date.now() - at < WAIT_MS) listener(value);
        }
        return () => { listeners.delete(listener); };
      }, []);
    },
  };
}
