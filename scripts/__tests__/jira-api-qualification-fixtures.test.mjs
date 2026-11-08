import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { observeQualificationFixtures } from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

it("observes restricted fixture metadata as the lab admin while retaining the API actor identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-fixture-authority-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
  const expectedAdmin = `Basic ${Buffer.from("keiko-admin:synthetic-admin").toString("base64")}`;
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const path = new URL(url).pathname;
    let value = [{ id: "1" }];
    let status = 200;
    if (path.endsWith("/project/KEIKO")) value = { id: "10000", key: "KEIKO" };
    if (path.endsWith("/myself")) value = { name: "keiko-api", key: "JIRAUSER10000" };
    if (path.endsWith("/role")) {
      status = options.headers.Authorization === expectedAdmin ? 200 : 403;
      value = status === 200 ? [{ id: "10002" }] : { errorMessages: ["Forbidden"] };
    }
    return new globalThis.Response(JSON.stringify(value), { status });
  });
  try {
    const result = await observeQualificationFixtures(
      { actor: "api", session: { ...DEFAULT_LAB_CONNECTION, directory } },
      { issueTypeId: "10001" },
    );
    expect(result).toMatchObject({
      actorKey: "JIRAUSER10000",
      roleId: "10002",
      projectId: "10000",
    });
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
