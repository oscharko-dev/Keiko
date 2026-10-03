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
  });

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
});
