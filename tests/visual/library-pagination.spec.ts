import { expect, test } from "@playwright/test";

test('large library pagination bounds cards and searches beyond the current page', async ({ page }) => {
  await page.addInitScript(() => {
    const define = Object.defineProperty;
    Object.defineProperty = function (target, name, descriptor) {
      if (target === window && name === 'leaflogue') {
        const bridge = descriptor.value as typeof window.leaflogue;
        descriptor.value = { ...bridge, library: { ...bridge.library,
          listBooks: async () => {
            const sample = (await bridge.library.listBooks())[0]!;
            return Array.from({ length: 5000 }, (_, i) => ({ ...sample, id: `synthetic-${i}` as typeof sample.id, title: `Synthetic book ${String(i).padStart(5, '0')}`, authors: ['Synthetic author'], series: undefined, seriesNumber: undefined, coverUrl: undefined, archived: false, highlightCount: 0 }));
          },
          findDuplicates: async () => ({ books: [], passages: [] }),
        }, organization: { ...bridge.organization, getBook: async () => undefined } };
      }
      return define(target, name, descriptor);
    };
  });
  await page.goto('/#/library');
  const cards = page.locator('a[aria-label^="Open Synthetic book"]');
  await expect(cards).toHaveCount(60);
  await expect(page.getByRole('navigation', { name: 'Book pages', exact: true })).toContainText('Books 1–60 of 5000');
  await page.getByRole('button', { name: 'Next books', exact: true }).click();
  await expect(cards.first()).toHaveAccessibleName('Open Synthetic book 00060');
  await expect(cards.first()).toBeFocused();
  await page.getByRole('searchbox', { name: 'Search your library', exact: true }).fill('Synthetic book 04999');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAccessibleName('Open Synthetic book 04999');
  await page.getByRole('searchbox', { name: 'Search your library', exact: true }).fill('');
  await expect(cards).toHaveCount(60);
  await expect(cards.first()).toHaveAccessibleName('Open Synthetic book 00000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
