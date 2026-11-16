import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readJiraNativeRegistry } from "../lib/jira-api-implementation.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function registry(tuple, tool = "jira.fixture") {
  const directory = mkdtempSync(join(tmpdir(), "keiko-jira-native-effects-"));
  directories.push(directory);
  const file = join(directory, "registry.ts");
  writeFileSync(file, `const NATIVE = { ${JSON.stringify(tool)}: ${JSON.stringify(tuple)} };`);
  return file;
}

it.each(["/search", "/worklog/list"])(
  "retains the explicit native read effect for POST %s",
  (path) => {
    expect(readJiraNativeRegistry(registry(["POST", "read", path, "fixture"])).entries).toEqual([
      {
        tool: "jira.fixture",
        identity: `POST /rest/api/2${path}`,
        effect: "read",
        permissionPolicy: "fixture",
      },
    ]);
  },
);
it("retains current-session observation under the separate fixed authentication root", () => {
  expect(
    readJiraNativeRegistry(registry(["GET", "read", "/session", "fixture", "/rest/auth/1"]))
      .entries[0]?.identity,
  ).toBe("GET /rest/auth/1/session");
});
const PROTECTED_OBSERVATIONS = [
  {
    tool: "jira.validate-create-user-password",
    path: "/password/policy/createUser",
    policy: "bound-protected-password-policy",
  },
  {
    tool: "jira.validate-update-user-password",
    path: "/password/policy/updateUser",
    policy: "bound-protected-password-policy",
  },
  {
    tool: "jira.validate-license",
    path: "/licenseValidator",
    policy: "instance-admin-protected-license-validation",
  },
];
it.each(PROTECTED_OBSERVATIONS)(
  "retains the exact protected read contract for $tool",
  ({ tool, path, policy }) => {
    expect(readJiraNativeRegistry(registry(["POST", "read", path, policy], tool)).entries).toEqual([
      { tool, identity: `POST /rest/api/2${path}`, effect: "read", permissionPolicy: policy },
    ]);
  },
);
it.each(PROTECTED_OBSERVATIONS)(
  "refuses protected observation substitutions for $tool",
  ({ tool, path, policy }) => {
    for (const tuple of [
      ["POST", "read", path, "fixture"],
      ["POST", "write", path, policy],
      ["POST", "read", path, policy, "/rest/auth/1"],
      ["PUT", "read", path, policy],
      ["POST", "read", `${path}/unreviewed`, policy],
    ])
      expect(() => readJiraNativeRegistry(registry(tuple, tool))).toThrow("registry-native-effect");
    expect(() => readJiraNativeRegistry(registry(["POST", "read", path, policy]))).toThrow(
      "registry-native-effect",
    );
  },
);
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
