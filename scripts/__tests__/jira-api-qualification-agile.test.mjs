import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { API_QUALIFICATION_AGILE_CASES } from "../testing/jira-chat-lab/api-qualification-agile-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
it("qualifies the owner-approved unconfirmed filter deletion only after exact native prior presence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-filter-delete-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  let present = true;
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("GET");
    if (new URL(url).pathname === "/rest/api/2/myself")
      return new globalThis.Response(JSON.stringify({ name: "keiko-admin", key: "admin-key" }), {
        status: 200,
      });
    expect(new URL(url).pathname).toBe("/rest/api/2/filter/11");
    return new globalThis.Response(
      JSON.stringify(
        present
          ? {
              id: "11",
              name: "Synthetic filter",
              jql: "project = KEIKO",
              description: null,
              owner: { key: "admin-key" },
            }
          : {
              errorMessages: [
                "The selected filter is not available to you, perhaps it has been deleted.",
              ],
              errors: {},
            },
      ),
      // Jira 10.3 answers an absent saved filter with a 400 that names the deletion.
      { status: present ? 200 : 400 },
    );
  });
  const entry = API_QUALIFICATION_AGILE_CASES.find((row) => row.tool === "jira.delete-filter");
  const ctx = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  const fixture = { agileFilterId: "11" };
  try {
    await entry.prepare(ctx, fixture);
    present = false;
    await expect(
      entry.readback(ctx, { outcome: "succeeded-unconfirmed", reason: "unavailable" }, fixture),
    ).resolves.toMatchObject({ matched: true, deletionConfirmed: false, observedStatus: 400 });
    await expect(entry.readback(ctx, {}, { agileFilterId: "11" })).rejects.toThrow();
    await expect(entry.readback(ctx, {}, { ...fixture, agileFilterId: "12" })).rejects.toThrow();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("admits unique typed Agile and saved-filter cases with explicit admin scope", () => {
  const fixture = {
    runId: "synthetic-run",
    agileActorKey: "actor-key",
    agileDefaultSharing: "PRIVATE",
    agileFilterId: "11",
    agileFilterReview: {
      filterId: "11",
      expectedOwnerKey: "actor-key",
      expectedName: "Synthetic filter",
      expectedJql: "project = KEIKO",
      expectedDescription: null,
    },
    agileBoardId: "13",
    agileBoardReview: {
      boardId: "13",
      expectedActorKey: "actor-key",
      expectedBoardName: "Synthetic board",
      expectedBoardType: "scrum",
      expectedFilterId: "11",
    },
    agileSprintId: "15",
    agileRefinedVelocity: false,
    issueKeys: ["KEIKO-1"],
  };
  const identities = new Set();
  for (const entry of API_QUALIFICATION_AGILE_CASES) {
    const operation = jiraOperationForTool(entry.tool);
    expect(operation, entry.tool).toBeDefined();
    expect(identities.has(operation.binding.identity), entry.tool).toBe(false);
    identities.add(operation.binding.identity);
    expect(
      describeCatalogSchemaMismatch(
        operation.declaration.descriptor.inputSchema,
        entry.arguments(fixture),
      ),
      entry.tool,
    ).toBeUndefined();
    expect(operation.definition.effects.includes("remote-write"), entry.tool).toBe(
      entry.mutation === true,
    );
    expect(entry).toMatchObject({ actor: "admin", administration: true });
  }
  expect(identities.size).toBeGreaterThanOrEqual(30);
});
it("matches Agile issue summaries against independent native fields and refuses contradictory content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-agile-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    expect(options.method).toBe("GET");
    return new globalThis.Response(
      JSON.stringify({
        issues: [{ id: "17", key: "KEIKO-1", fields: { summary: "Synthetic summary" } }],
        total: 1,
      }),
      { status: 200 },
    );
  });
  const entry = API_QUALIFICATION_AGILE_CASES.find((e) => e.tool === "jira.board-issues");
  const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  try {
    await expect(
      entry.readback(
        context,
        { items: [{ id: "17", key: "KEIKO-1", summary: "Synthetic summary" }] },
        { agileBoardId: "13" },
      ),
    ).resolves.toMatchObject({ matched: true });
    await expect(
      entry.readback(
        context,
        { items: [{ id: "17", key: "KEIKO-1", summary: "Wrong summary" }] },
        { agileBoardId: "13" },
      ),
    ).rejects.toThrow();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps synthetic sprint names within the observed native 30-character limit", () => {
  const entry = API_QUALIFICATION_AGILE_CASES.find((e) => e.tool === "jira.sprint-create");
  const first = entry.arguments({
    agileBoardId: "13",
    runId: "11111111-1111-4111-8111-111111111111",
  });
  const second = entry.arguments({
    agileBoardId: "13",
    runId: "22222222-2222-4222-8222-222222222222",
  });
  expect(first.name.length).toBeLessThanOrEqual(30);
  expect(second.name).not.toBe(first.name);
});

it("does not infer backlog removal from a filtered empty sprint list without canonical field proof", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-backlog-oracle-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  let value = null;
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("GET");
    const path = new URL(url).pathname;
    const bodies = {
      "/rest/agile/1.0/sprint/15": { id: 15 },
      "/rest/agile/1.0/sprint/15/issue": { total: 0, issues: [] },
      "/rest/agile/1.0/issue/KEIKO-1": { id: "17", key: "KEIKO-1" },
      "/rest/api/2/field": [
        { id: "customfield_10020", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
      ],
      "/rest/api/2/issue/KEIKO-1": {
        id: "17",
        key: "KEIKO-1",
        fields: { customfield_10020: value },
      },
    };
    expect(Object.hasOwn(bodies, path)).toBe(true);
    return new globalThis.Response(JSON.stringify(bodies[path]), { status: 200 });
  });
  const entry = API_QUALIFICATION_AGILE_CASES.find((e) => e.tool === "jira.backlog-move-issues");
  const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  const fixture = { agileSprintId: "15", issueKeys: ["KEIKO-1"] };
  try {
    await expect(entry.readback(context, {}, fixture)).resolves.toMatchObject({ matched: true });
    value = [{ id: 19, state: "future" }];
    await expect(entry.readback(context, {}, fixture)).rejects.toThrow();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("refuses the backlog move when the refused sprint move left the issue outside the sprint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-backlog-prep-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  let member = false;
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    const bodies = {
      "/rest/api/2/myself": { name: "keiko-admin", key: "admin-key" },
      "/rest/agile/1.0/sprint/15/issue": { total: 1, issues: member ? [{ key: "KEIKO-1" }] : [] },
      "/rest/api/2/field": [
        { id: "customfield_10020", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
      ],
      "/rest/api/2/issue/KEIKO-1": {
        key: "KEIKO-1",
        fields: { customfield_10020: member ? [{ id: 19 }] : null },
      },
    };
    expect(Object.hasOwn(bodies, path)).toBe(true);
    return new globalThis.Response(JSON.stringify(bodies[path]), { status: 200 });
  });
  const entry = API_QUALIFICATION_AGILE_CASES.find((e) => e.tool === "jira.backlog-move-issues");
  const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  const fixture = { agileSprintId: "15", issueKeys: ["KEIKO-1"] };
  try {
    await expect(entry.prepare(context, fixture)).rejects.toThrow();
    member = true;
    await expect(entry.prepare(context, fixture)).resolves.toBeUndefined();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
it("qualifies the sprint update only when the native sprint carries the new name and goal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-sprint-rename-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const fixture = { agileSprintId: "15", runId: "0123456789abcdef0123456789abcdef" };
  const entry = API_QUALIFICATION_AGILE_CASES.find((e) => e.tool === "jira.sprint-update");
  const args = entry.arguments(fixture);
  expect(Object.keys(args).sort()).toEqual(["goal", "name", "sprintId"]);
  let name = args.name;
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(new URL(url).pathname).toBe("/rest/agile/1.0/sprint/15");
    return new globalThis.Response(JSON.stringify({ id: 15, name, goal: args.goal }), {
      status: 200,
    });
  });
  const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  try {
    await expect(entry.readback(context, {}, fixture)).resolves.toMatchObject({ matched: true });
    name = `AC7-${fixture.runId.slice(0, 26)}`;
    await expect(entry.readback(context, {}, fixture)).rejects.toThrow();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
