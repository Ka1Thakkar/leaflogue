import { startLeaflogue } from "./boot";
import { installPreviewBridge } from "./preview-bridge";

// Outside Electron during development, run on an in-memory library instead.
// Production builds drop this branch, and the preview library with it.
if (import.meta.env.DEV && !window.leaflogue) installPreviewBridge();

void startLeaflogue(document.getElementById("root")!);
