import { join } from "node:path";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { Arch } from "electron-builder";

/** The file the fuses live in: a bundle on macOS, an .exe on Windows. */
export function packagedExecutable(context) {
  const { electronPlatformName: platform, appOutDir, packager } = context;
  if (platform === "darwin") return join(appOutDir, `${packager.appInfo.productFilename}.app`);
  if (platform === "win32") return join(appOutDir, `${packager.appInfo.productFilename}.exe`);
  return join(appOutDir, packager.executableName);
}

// afterPack runs before electron-builder signs, so a later signature covers
// the flipped fuses. Unsigned Apple-silicon builds still need the ad-hoc
// signature Electron ships with renewed, or the edited binary will not launch.
export default async function hardenElectron(context) {
  await flipFuses(packagedExecutable(context), {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: context.electronPlatformName === "darwin" && context.arch === Arch.arm64,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  });
}
