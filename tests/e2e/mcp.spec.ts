import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";
import { launchPackagedApp } from "./packaged-process";
import { createProfile, isolatedProfileEnvironment, launch, removeProfile } from "./harness";

/** Real client -> real stdio process -> read-only SQLite; no real user data. */
for (const packaged of [false, true]) {
test(`${packaged ? "packaged" : "source"} MCP returns citations and revokes access without changing reading data`, async () => {
  const executable = process.env.LEAFLOGUE_PACKAGED_EXECUTABLE;
  test.skip(packaged ? !executable : !!executable, "Run the matching source or packaged MCP boundary for this environment");
  const profile = createProfile();
  const native = packaged ? await launchPackagedApp(executable!, profile) : undefined;
  const source = packaged ? undefined : await launch(profile);
  const session = { page: native?.page ?? source!.page, close: async () => {
    if (native) { await native.quit(); await native.browser.close(); }
    else await source!.close();
  } };
  const client = new Client({ name: "leaflogue-e2e", version: "1" });
  let transport: StdioClientTransport | undefined;
  try {
    await session.page.getByRole("button", { name: "Set up later" }).click();
    const ids = await session.page.evaluate(async () => {
      const book = await window.leaflogue.library.createBook({ title: "A Reader's Test Book", authors: ["Test Author"] });
      const passage = await window.leaflogue.library.createHighlight({ bookId: book.id, text: "The tide keeps its own calendar.", sourceLocation: "Chapter 2" });
      return { bookId: book.id, passageId: passage.id };
    });
    await session.page.evaluate(() => { location.hash = "#/settings"; });
    await session.page.getByText("Local MCP · Agent access", { exact: true }).click();
    const toggle = session.page.getByRole("switch", { name: "Enable local MCP access" });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(session.page.getByRole("status").filter({ hasText: "Read-only agent access is enabled." })).toBeVisible();
    const settings = JSON.parse(await session.page.getByRole("textbox", { name: "MCP client configuration" }).inputValue()) as { mcpServers: { leaflogue: { command: string; args: string[]; env?: Record<string, string> } } };
    const configuration = settings.mcpServers.leaflogue;
    transport = new StdioClientTransport({ ...configuration, args: [...configuration.args, ...(process.env.LEAFLOGUE_E2E_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])], env: { ...isolatedProfileEnvironment(profile), ...configuration.env }, stderr: "pipe" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(5);
    const answer = await client.callTool({ name: "search_passages", arguments: { query: "tide" } });
    expect(answer.isError).not.toBe(true);
    const text = JSON.stringify(answer);
    expect(text).toContain("Chapter 2"); expect(text).toContain("Test Author"); expect(text).toContain(ids.passageId);
    await toggle.uncheck();
    await expect(session.page.getByRole("status").filter({ hasText: "Agent access is disabled." })).toBeVisible();
    const denied = await client.callTool({ name: "search_passages", arguments: { query: "tide" } });
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).not.toContain("The tide");
    expect(await session.page.evaluate(async id => (await window.leaflogue.library.getBookContents(id))?.highlights.length, ids.bookId)).toBe(1);
  } finally {
    await client.close(); await transport?.close(); await session.close(); await removeProfile(profile);
  }
});
}
