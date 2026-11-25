export type ReaderKeyAction = "menu" | "next" | "previous" | "first" | "last";

/** Controls that own their keys: typing, menus, lists, dialogs and the reader's own popups. */
const OWNED = [
  "[data-reader-selection]", "input", "textarea", "select", '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]', '[role="combobox"]', '[role="listbox"]', '[role="option"]', '[role="menu"]', '[role="menubar"]',
  '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="slider"]', '[role="spinbutton"]',
  "dialog", '[role="dialog"]', '[role="alertdialog"]', '[role="separator"]',
].join(",");
/** While one of these is open anywhere in the window, the reader leaves every key alone. */
const OPEN_POPUPS = 'dialog[open],[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"]';

function shown(element: Element) {
  return element.getClientRects().length > 0 && !element.closest("[hidden]") && (element as HTMLElement).dataset?.state !== "closed";
}

/**
 * Decide which reader shortcut, if any, a key press is. Every guard runs
 * before any shortcut, including Shift+F10, so another control keeps its keys
 * and nothing is prevented unless the reader handles it.
 */
export function readerKeyAction(event: KeyboardEvent, root: Document = document): ReaderKeyAction | undefined {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return undefined;
  const target = event.target as Element | null;
  if (target?.closest?.(OWNED)) return undefined;
  if (Array.from(root.querySelectorAll(OPEN_POPUPS)).some(shown)) return undefined;
  if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") return "menu";
  if (event.shiftKey && event.key !== " ") return undefined;
  if (target?.closest?.('[role="tab"]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return undefined;
  if (event.key === " " && target?.closest?.("button,a,summary")) return undefined;
  if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) || (event.key === " " && !event.shiftKey)) return "next";
  if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey)) return "previous";
  if (event.key === "Home") return "first";
  if (event.key === "End") return "last";
  return undefined;
}
