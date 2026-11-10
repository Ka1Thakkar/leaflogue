import "@leaflogue/ui/ui.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { activateStoredAppearance } from "./appearance";
import "./styles.css";

/** Render Leaflogue into the page once `window.leaflogue` is in place, in the desktop app or the web app. */
export async function startLeaflogue(root: HTMLElement): Promise<void> {
  await activateStoredAppearance(() => window.leaflogue.appearance.describe());
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
