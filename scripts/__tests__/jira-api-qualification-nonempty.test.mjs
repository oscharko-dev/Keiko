import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { versionFixtureArguments } from "../testing/jira-chat-lab/api-qualification-fixtures.mjs";
import { readCase } from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { API_QUALIFICATION_AGILE_CASES } from "../testing/jira-chat-lab/api-qualification-agile-cases.mjs";
import { API_QUALIFICATION_RELEASE_CASES } from "../testing/jira-chat-lab/api-qualification-release-cases.mjs";
import { API_QUALIFICATION_PROPERTY_CASES } from "../testing/jira-chat-lab/api-qualification-property-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

function session() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-nonempty-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  return {
    directory,
    context: { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } },
  };
}
const respond = (body) => async (url) => {
  expect(new URL(url).pathname).toBeTruthy();
  return new globalThis.Response(JSON.stringify(body), { status: 200 });
};

it("refuses an empty owned collection for a read that asks for a nonempty fixture", async () => {
  const { directory, context } = session();
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(respond({ values: [] }));
  try {
    const plain = readCase("jira.boards", "/rest/api/2/x", ["id"], { nativeRoot: "values" });
    await expect(plain.readback(context, { items: [] }, {})).resolves.toMatchObject({
      matched: true,
    });
    const owned = readCase("jira.boards", "/rest/api/2/x", ["id"], {
      nativeRoot: "values",
      nonEmpty: true,
    });
    await expect(owned.readback(context, { items: [] }, {})).rejects.toThrow(/natively present/u);
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("declares the owned fixture reads of the audited cases as nonempty", async () => {
  const { directory, context } = session();
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    const empty = path.endsWith("/remotelink")
      ? { links: [] }
      : path.endsWith("/properties")
        ? { keys: [] }
        : path.endsWith("/permission")
          ? []
          : { values: [] };
    return new globalThis.Response(JSON.stringify(empty), { status: 200 });
  });
  const fixture = {
    runId: "r",
    agileBoardId: "13",
    versionId: "7",
    savedFilterId: "9",
    linkSuffixes: ["a"],
    createdIssueKey: "KEIKO-1",
    projectId: "1",
  };
  try {
    const byTool = (list, tool) => list.find((entry) => entry.tool === tool);
    for (const [list, tool] of [
      [API_QUALIFICATION_AGILE_CASES, "jira.boards"],
      [API_QUALIFICATION_RELEASE_CASES, "jira.version-remote-links"],
      [API_QUALIFICATION_RELEASE_CASES, "jira.remote-version-links"],
      [API_QUALIFICATION_PROPERTY_CASES, "jira.board-property-keys"],
    ]) {
      const entry = byTool(list, tool);
      if (entry === undefined) continue;
      await expect(entry.readback(context, { items: [] }, fixture)).rejects.toThrow(
        /natively present/u,
      );
    }
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("never leaves a link fixture changed by a refused write", async () => {
  const { directory, context } = session();
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(respond({ links: [] }));
  const entry = API_QUALIFICATION_RELEASE_CASES.find(
    (row) => row.tool === "jira.upsert-version-remote-link",
  );
  const fixture = { runId: "r", versionId: "7", linkSuffixes: [] };
  try {
    await expect(entry.readback(context, { globalId: "x" }, fixture)).rejects.toThrow();
    expect(fixture.linkSuffixes).toEqual([]);
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("builds auxiliary version arguments the governed create-version schema accepts", async () => {
  const schema = jiraOperationForTool("jira.create-version").declaration.descriptor.inputSchema;
  const args = versionFixtureArguments(
    { projectId: "10000" },
    "AC7 move source 2f822fba-561d-4b08-805d-119a3e845b17",
  );
  expect(describeCatalogSchemaMismatch(schema, args)).toBeUndefined();
});
