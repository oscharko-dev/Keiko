import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readJiraNativeRegistry } from "../lib/jira-api-implementation.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function registry(tuple) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-jira-native-effects-"));
  directories.push(directory);
  const file = join(directory, "registry.ts");
  writeFileSync(file, `const NATIVE = { "jira.fixture": ${JSON.stringify(tuple)} };`);
  return file;
}

it.each(["/search", "/worklog/list"])("retains the explicit native read effect for POST %s", (path) => {
  expect(readJiraNativeRegistry(registry(["POST", "read", path, "fixture"])).entries).toEqual([
    { tool: "jira.fixture", identity: `POST /rest/api/2${path}`, effect: "read", permissionPolicy: "fixture" },
  ]);
});
it("retains current-session observation under the separate fixed authentication root", () => {
  expect(readJiraNativeRegistry(registry(["GET", "read", "/session", "fixture", "/rest/auth/1"])).entries[0]?.identity)
    .toBe("GET /rest/auth/1/session");
});
it.each([
  { tuple: ["POST", "read", "/issue", "fixture"] },
  { tuple: ["POST", "read", "/search", "fixture", "/rest/auth/1"] },
  { tuple: ["PUT", "read", "/search", "fixture"] },
  { tuple: ["DELETE", "read", "/worklog/list", "fixture"] },
  { tuple: ["POST", "write", "/search", "fixture"] },
  { tuple: ["GET", "read", "/session", "fixture", "/rest/private/1"] },
])("refuses method/root/effect substitution in $tuple", ({ tuple }) => {
  expect(() => readJiraNativeRegistry(registry(tuple))).toThrow();
});
