import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function internalToolNames(): Promise<string[]> {
  const source = await readFile("src/drivers/observations.ts", "utf8");
  const match = /const INTERNAL_TOOL_CALLS = new Set\((\[[\s\S]*?\])\);/.exec(source);
  if (!match?.[1]) throw new Error("Could not read INTERNAL_TOOL_CALLS from observations.ts.");
  return JSON.parse(match[1]) as string[];
}

describe("eval documentation contracts", () => {
  it("does not prescribe tool-call assertions for filtered internal tools", async () => {
    const docPaths = [
      "README.md",
      ...(await readdir("docs")).filter((name) => name.endsWith(".md")).map((name) => join("docs", name)),
    ];
    const docs = await Promise.all(docPaths.map(async (path) => ({
      path,
      content: await readFile(path, "utf8"),
    })));

    for (const name of await internalToolNames()) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const assertion = new RegExp(
        `"type"\\s*:\\s*"tool-call"\\s*,\\s*"name"\\s*:\\s*"${escapedName}"`,
      );
      for (const doc of docs) {
        expect(doc.content, `${doc.path} asserts filtered internal tool ${name}`).not.toMatch(assertion);
      }
    }
  });

  it("does not claim the private v0 package can be installed from npm", async () => {
    const docPaths = ["README.md", "docs/QUICKSTART.md", "docs/DOWNSTREAM-GUIDE.md"];
    const registryInstall = /npm\s+(?:install|i|add)\s+(?:--[^\s]+\s+)*pilotswarm-eval-harness\b/i;

    for (const path of docPaths) {
      const content = await readFile(path, "utf8");
      expect(content, `${path} contains a published-package install command`).not.toMatch(registryInstall);
    }
  });
});
