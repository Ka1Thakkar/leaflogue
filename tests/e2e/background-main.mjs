// Test-only launcher: exercise the real desktop bridge without showing or
// activating a native window on the developer's desktop. Native window
// activation/OS-dialog acceptance still belongs to the normal CI launcher.
import process from "node:process";
import { app, BrowserWindow } from "electron";
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
app.on("ready", () => app.dock?.hide());
void import(process.env.LEAFLOGUE_E2E_MAIN_URL);
