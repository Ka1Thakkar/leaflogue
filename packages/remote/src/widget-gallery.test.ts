import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WIDGET_LIMITS } from "@leaflogue/contracts";
import { parseCustomWidgetFile } from "@leaflogue/domain";

/*
 * The docs site's Plugins page offers these files for anyone to download and
 * import. Each must import cleanly into any Leaflogue that reads version 1.
 */
const GALLERY = fileURLToPath(new URL("../../../apps/docs/public/widgets/", import.meta.url));
const files = readdirSync(GALLERY).filter((name) => name.endsWith(".json")).sort();

describe("the widget gallery", () => {
  it("has widgets to offer", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)("%s is a valid widget named after its ID", (name) => {
    expect(name).toMatch(/\.leaflogue-widget\.json$/u);
    expect(statSync(`${GALLERY}${name}`).size).toBeLessThanOrEqual(WIDGET_LIMITS.fileBytes);
    const widget = parseCustomWidgetFile(JSON.parse(readFileSync(`${GALLERY}${name}`, "utf8")));
    expect(name).toBe(`${widget.id}.leaflogue-widget.json`);
    // The gallery card shows the description, so every gallery widget has one.
    expect(widget.description).toBeTruthy();
  });

  it("gives every widget its own ID", () => {
    const ids = files.map((name) => parseCustomWidgetFile(JSON.parse(readFileSync(`${GALLERY}${name}`, "utf8"))).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
