import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPTIONAL_WIDGET_DE_MESSAGES } from "./i18n-messages.optional.de";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "./i18n-messages.optional.en";

// Every German message source: the core catalog, the optional widget catalog and every other
// German catalog module of the UI (for example the Knowledge Pod page).
function germanCatalogFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...germanCatalogFiles(path));
    else if (/(?:^|[.-])de\.tsx?$/u.test(entry.name) && !/\.test\./u.test(entry.name))
      found.push(path);
  }
  return found;
}

describe("Jira Pod terminology (#4353)", () => {
  it("scans every German catalog and finds none that spells the Pod name with a hyphen", () => {
    const files = germanCatalogFiles(join(__dirname, ".."));
    expect(files.length).toBeGreaterThanOrEqual(3);
    const hyphenated = files.filter((file) => /Jira-Pods?\b/u.test(readFileSync(file, "utf8")));
    expect(hyphenated.map((file) => file.slice(file.indexOf("src/")))).toEqual([]);
  });
  it("gives every closed auth-unverified message in both languages and none of them names a host or identity", () => {
    for (const catalog of [OPTIONAL_WIDGET_EN_MESSAGES, OPTIONAL_WIDGET_DE_MESSAGES]) {
      for (const key of [
        "chat.jira.outcome.failure.authUnverified",
        "atlassianConnectors.result.reason.auth-unverified",
        "atlassianConnectors.sync.reason.auth-unverified",
      ] as const) {
        const text = catalog[key];
        expect(text.length).toBeGreaterThan(20);
        expect(text).not.toMatch(/https?:|@|\{/u);
      }
    }
  });
});
