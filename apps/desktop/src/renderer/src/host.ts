import { createContext, useContext } from "react";
import type { SystemHost } from "@leaflogue/contracts";

export const DESKTOP_HOST: SystemHost = { kind: "desktop" };

/** Where this interface runs. The desktop app is the default; the web app says otherwise. */
export const HostContext = createContext<SystemHost>(DESKTOP_HOST);

/** The host the capabilities name, else the one the bridge names, else the desktop app. */
export function hostOf(host: SystemHost | undefined): SystemHost {
  return host ?? window.leaflogue?.host ?? DESKTOP_HOST;
}

export function useHost(): SystemHost {
  return useContext(HostContext);
}

/**
 * Native dialogs, files and folders on this computer, plugged-in e-readers,
 * sync, backups, the themes folder, and updates exist only in the desktop app.
 */
export function useDesktop(): boolean {
  return useHost().kind === "desktop";
}

/**
 * Whether readers can build, import, and share their own widgets. The desktop
 * app can; the web app leaves them out unless whoever deploys it says so.
 */
export function hasCustomWidgets(host: SystemHost): boolean {
  return host.kind === "desktop" || host.customWidgets === true;
}

export function useCustomWidgets(): boolean {
  return hasCustomWidgets(useHost());
}
