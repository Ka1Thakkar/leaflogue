import type { Locator } from "@playwright/test";

/** Choose the visible custom option through the same controls a reader uses. */
export async function selectOption(control: Locator, value: string): Promise<void> {
  await control.click();
  await control.page().locator(`[role="option"][data-value=${JSON.stringify(value)}]:visible`).click();
}
