import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";
import { satteri } from "@astrojs/markdown-satteri";

// Vercel exposes the production hostname at build time. Set SITE_URL to
// override it when the site moves to its own host.
const site = process.env.SITE_URL
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);

export default defineConfig({
  site,
  telemetry: false,
  devToolbar: { enabled: false },
  markdown: { processor: satteri({ hastPlugins: [{
    name: "external-links",
    element: { filter: ["a"], visit(node, context) {
      if (node.tagName === "a" && /^(https?:)?\/\//iu.test(String(node.properties?.href ?? ""))) {
        context.setProperty(node, "target", "_blank");
        context.setProperty(node, "rel", ["noopener", "noreferrer"]);
      }
    } },
  }] }) },
  integrations: [
    react(),
    starlight({
      title: "Leaflogue",
      description: "A local-first home for books, passages, and reading notes.",
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "Leaflogue on GitHub", href: "https://github.com/Ka1Thakkar/leaflogue" }],
      editLink: { baseUrl: "https://github.com/Ka1Thakkar/leaflogue/edit/main/apps/docs/" },
      customCss: ["./src/styles/tokens.css", "./src/styles/docs.css", "./src/styles/salon-docs.css"],
      credits: false,
      components: {
        SiteTitle: "./src/components/SiteTitle.astro",
        PageTitle: "./src/components/EmptyPageTitle.astro",
        PageFrame: "./src/components/SalonPageFrame.astro",
        Header: "./src/components/SalonHeader.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        SocialIcons: "./src/components/SocialIcons.astro",
        EditLink: "./src/components/EditLink.astro",
      },
      sidebar: [
        { label: "Start here", items: ["start/install", "start/first-library", "start/navigation", "start/files-and-settings", "start/release-notes"] },
        { label: "Your library", items: ["library/importing", "library/reading", "library/dictionary", "library/dashboards", "library/backups", "library/exporting"] },
        { label: "Widgets", items: ["widgets/custom-widgets", "widgets/plugins"] },
        { label: "Sync (optional)", items: ["sync/overview", "sync/convex", "sync/postgresql", "sync/conflicts"] },
        { label: "AI and agents (optional)", items: ["ai/gemini", "ai/mcp"] },
        { label: "Web app (optional)", items: ["web/overview", "web/postgresql", "web/convex"] },
        { label: "Help", items: ["help/troubleshooting", "help/privacy", "help/support"] },
      ],
    }),
  ],
});
