import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { generateSupportCodeInventory } from "../generate-support-code-inventory.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function source(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

describe("support report code inventory", () => {
  it("matches the checked-in inventory derived from current product sources", async () => {
    expect(await generateSupportCodeInventory(repoRoot)).toBe(
      readFileSync(
        join(
          repoRoot,
          "packages/keiko-activity-log/src/reader/support-code-inventory.generated.ts",
        ),
        "utf8",
      ),
    );
  }, 120_000);

  it("includes only owned modules and declared technical symbols, excluding fixtures and links", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-support-inventory-"));
    roots.push(root);
    source(root, "src/cli/main.ts", "export class CliFailure extends TypeError {};");
    source(
      root,
      "packages/keiko-server/src/files.ts",
      'class ParentFailure extends Error {}\nclass FileFailure extends ParentFailure {}\nconst event = { code: "EACCES", source: "files", message: "CustomerPayroll" };',
    );
    source(root, "packages/keiko-ui/src/app/page.tsx", "export const page = <div />;");
    const fixture = source(
      root,
      "packages/keiko-server/src/fixtures/CustomerData.ts",
      'class CustomerError extends Error {}\nconst event = { code: "CustomerToken" };',
    );
    source(
      root,
      "packages/keiko-server/src/files.test.ts",
      "class CustomerTestError extends Error {}",
    );
    source(
      root,
      "packages/keiko-server/src/private.generated.ts",
      "class GeneratedCustomerError extends Error {}",
    );
    symlinkSync(fixture, join(root, "packages/keiko-server/src/CustomerLink.ts"));
    const result = await generateSupportCodeInventory(root);
    expect(result).toContain('"keiko-server/files"');
    expect(result).toContain('"keiko-ui/app/page"');
    expect(result).toContain('"cli/main"');
    expect(result).toContain('"FileFailure"');
    expect(result).toContain('"EACCES"');
    expect(result).not.toContain("Customer");
    expect(result).not.toContain("files.test");
    expect(await generateSupportCodeInventory(root)).toBe(result);
  });
  it("ignores ancestor labels and includes closed producer vocabularies", async () => {
    const ancestor = mkdtempSync(join(tmpdir(), "keiko-inventory-"));
    roots.push(ancestor);
    const root = join(ancestor, "fixtures", "__tests__", "checkout.test.case");
    source(root, "src/cli/main.ts", "export const cli = true;");
    source(
      root,
      "packages/keiko-git/src/errors.ts",
      `
      const CLOSED_GIT_ERROR_KINDS = { "spawn-failed": true };
      function classify() { return "merge-conflict"; }
      git(["rev-parse", customerBranch]);
      class GitFailure extends Error { code = "EREVISION"; }
      const event = { operation: "workspace-register", source: "activity-log-reader" };
    `,
    );
    source(
      root,
      "packages/keiko-tool-catalog/src/legacy.ts",
      `
      registration("keiko.file.read", "read_file");
      createToolRef("keiko.child.workspace.read", 1);
      registration(customerTool, customerAlias);
      const profile = { profile: { id: "legacy-native" } };
    `,
    );
    source(
      root,
      "packages/keiko-git/src/runner.ts",
      'const config = ["alias.fetch=", "pager.push=false"];',
    );
    source(
      root,
      "packages/keiko-local-knowledge/src/indexing/orchestrator-activity-log.ts",
      'const EXACT_FAILURE_ERROR_KINDS = { LIMIT_REACHED: "validation-failed" }; function activityFailureKind(kind) { return nested === undefined ? kind : `DISCOVERY_FAILED.${nested}`; }',
    );
    const result = await generateSupportCodeInventory(root);
    for (const symbol of [
      "fetch",
      "push",
      "DISCOVERY_FAILED.LIMIT_REACHED",
      "LIMIT_REACHED",
      "spawn-failed",
      "merge-conflict",
      "rev-parse",
      "EREVISION",
      "workspace-register",
      "activity-log-reader",
      "keiko.file.read",
      "keiko.child.workspace.read",
      "legacy-native",
      "ConnectTimeoutError",
    ])
      expect(result).toContain(JSON.stringify(symbol));
    expect(result).toContain('"keiko-git/errors"');
    expect(result).not.toContain("customer");
  });
});
