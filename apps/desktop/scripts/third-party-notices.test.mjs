import { describe, expect, it } from "vitest";
import { assertAllowedLicenses, collectPackages, renderNotices } from "./third-party-notices.mjs";

const tree = {
  dependencies: {
    "@leaflogue/desktop": {
      version: "0.0.0",
      path: "/repo/apps/desktop",
      dependencies: {
        react: { version: "19.3.0", license: "MIT", path: "/nm/react", repository: { url: "git+https://github.com/facebook/react.git" } },
        "@fontsource-variable/fraunces": { version: "5.3.0", license: "OFL-1.1", path: "/nm/fraunces" },
        "@clerk/react": { missing: true },
        pg: { version: "8.23.0", license: "MIT", path: "/nm/pg", dependencies: { react: { version: "19.3.0", license: "MIT", path: "/nm/react" } } },
      },
    },
  },
};

describe("third-party notices", () => {
  it("collects each installed package once and skips uninstalled optional peers", () => {
    expect(collectPackages(tree).map(({ name, version }) => `${name}@${version}`)).toEqual([
      "@fontsource-variable/fraunces@5.3.0",
      "@leaflogue/desktop@0.0.0",
      "pg@8.23.0",
      "react@19.3.0",
    ]);
  });

  it("accepts allowlisted licences and the project's own packages", () => {
    expect(() => assertAllowedLicenses(collectPackages(tree))).not.toThrow();
  });

  it("stops distribution for unknown, missing, or incompatible licences", () => {
    for (const license of [undefined, "GPL-2.0-only", "SSPL-1.0", "UNLICENSED", "(MIT OR GPL-3.0)"]) {
      expect(() => assertAllowedLicenses([{ name: "left-pad", version: "1.0.0", license, path: "/nm/left-pad" }]))
        .toThrow(/left-pad@1.0.0/u);
    }
  });

  it("renders licence texts with sources and neutralises embedded fences", () => {
    const notices = renderNotices([
      { name: "react", version: "19.3.0", license: "MIT", repository: { url: "git+https://github.com/facebook/react.git" }, text: "MIT License\n```\n" },
      { name: "@esbuild/linux-x64", version: "0.27.0", license: "MIT" },
    ]);
    expect(notices).toContain("Leaflogue is licensed under AGPL-3.0-or-later");
    expect(notices).toContain("## react 19.3.0\n\nLicence: MIT\nSource: https://github.com/facebook/react\n\n```text\nMIT License\n'''\n```");
    expect(notices).toContain("does not include a separate licence file; it is distributed under MIT.");
    expect(notices.endsWith("\n")).toBe(true);
  });
});
