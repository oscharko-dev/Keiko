import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { expressibleGrants } from "../testing/jira-chat-lab/api-qualification-association-cases.mjs";
import { versionFixtureArguments } from "../testing/jira-chat-lab/api-qualification-fixtures.mjs";
import { readCase } from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { API_QUALIFICATION_OBSERVATION_CASES } from "../testing/jira-chat-lab/api-qualification-observation-cases.mjs";
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
it("copies only permission grants the governed create-permission-scheme schema accepts", () => {
  const schema = jiraOperationForTool("jira.create-permission-scheme").declaration.descriptor
    .inputSchema;
  const review = {
    permissions: [
      { id: "1", permission: "BROWSE_PROJECTS", holder: { type: "applicationRole" } },
      {
        id: "2",
        permission: "BROWSE_PROJECTS",
        holder: { type: "projectRole", parameter: "10002" },
      },
      { id: "3", permission: "CREATE_ISSUES", holder: { type: "anyone" } },
    ],
  };
  const permissions = expressibleGrants(review);
  expect(permissions).toHaveLength(2);
  expect(
    describeCatalogSchemaMismatch(schema, {
      expectedActorKey: "JIRAUSER10000",
      name: "x",
      description: "d",
      permissions,
    }),
  ).toBeUndefined();
  expect(() => expressibleGrants({ permissions: [review.permissions[0]] })).toThrow();
});
it.each([
  ["epoch ms", 1_794_214_220_465, "2026-11-09T08:50:20.465Z", true],
  ["epoch ms against a different instant", 1_794_214_220_465, "2026-11-09T08:50:20.466Z", false],
  ["text", "2026-11-09", "2026-11-09", true],
  ["text against different text", "2026-11-09", "2026-11-10", false],
])(
  "compares the custom-fields lastValueUpdate oracle for %s",
  async (_label, native, product, ok) => {
    const { directory, context } = session();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        respond({ values: [{ id: "customfield_10000", name: "F", lastValueUpdate: native }] }),
      );
    try {
      const entry = API_QUALIFICATION_OBSERVATION_CASES.find(
        (row) => row.tool === "jira.custom-fields",
      );
      const data = { items: [{ id: "customfield_10000", name: "F", lastValueUpdate: product }] };
      const outcome = entry.readback(context, data, {});
      if (ok) await expect(outcome).resolves.toMatchObject({ matched: true });
      else await expect(outcome).rejects.toThrow();
    } finally {
      spy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
