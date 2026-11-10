import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppHeader, Bars, NavRail, Ranked } from "./index";

describe("shared interface", () => {
  it("marks the current page in the breadcrumb and the rail", () => {
    const header = renderToStaticMarkup(
      <AppHeader brand="Leaflogue" brandHref="#/" crumbs={[{ label: "Library", href: "#/library" }, { label: "Piranesi" }]} inset="traffic-lights" />,
    );
    expect(header).toContain('data-inset="traffic-lights"');
    expect(header).toContain('<a href="#/library">Library</a>');
    expect(header).toContain('<span aria-current="page">Piranesi</span>');

    const rail = renderToStaticMarkup(
      <NavRail items={[
        { href: "#/library", label: "Library", icon: null, current: true },
        { href: "#/settings", label: "Settings", icon: null, placement: "end", badge: 3 },
      ]} />,
    );
    expect(rail).toContain('aria-current="page"');
    expect(rail).toContain("ui-rail-end");
    expect(rail).toContain('aria-label="3 waiting"');
  });

  it("scales bars to the largest value and keeps the figures readable", () => {
    const chart = renderToStaticMarkup(<Bars title="Passages per day" bars={[{ label: "Mon", value: 2 }, { label: "Tue", value: 8, highlight: true }]} />);
    expect(chart).toContain("height:25%");
    expect(chart).toContain("height:100%");
    expect(chart).toContain("<caption>Passages per day</caption>");
    expect(chart).toContain("<th scope=\"row\">Tue</th><td>8</td>");

    const ranked = renderToStaticMarkup(<Ranked entries={[{ key: "a", label: "Dinniman", value: 1070 }, { key: "b", label: "Clarke", value: 292 }]} />);
    expect(ranked).toContain("1,070");
    expect(ranked).toMatch(/width:27\.\d+%/);
  });
});
