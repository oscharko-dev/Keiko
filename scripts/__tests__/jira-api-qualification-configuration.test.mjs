import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import { API_QUALIFICATION_CONFIGURATION_CASES } from "../testing/jira-chat-lab/api-qualification-configuration-cases.mjs";
import { API_QUALIFICATION_ISSUE_CASES } from "../testing/jira-chat-lab/api-qualification-issue-cases.mjs";
import { API_QUALIFICATION_PROPERTY_CASES } from "../testing/jira-chat-lab/api-qualification-property-cases.mjs";

it("binds issue and property lifecycle arguments to the real operation contracts", () => {
  const fixture = {
    projectId: "10000",
    issueTypeId: "10003",
    issueKeys: ["KEIKO-1"],
    createdIssueKey: "KEIKO-4",
    commentId: "37",
    worklogId: "41",
    transitionId: "11",
    runId: "synthetic-run",
  };
  for (const specification of [
    ...API_QUALIFICATION_ISSUE_CASES,
    ...API_QUALIFICATION_PROPERTY_CASES,
  ]) {
    const operation = jiraOperationForTool(specification.tool);
    expect(operation, specification.tool).toBeDefined();
    expect(
      describeCatalogSchemaMismatch(
        operation.declaration.descriptor.inputSchema,
        specification.arguments(fixture),
      ),
      specification.tool,
    ).toBeUndefined();
  }
});

it("selects actual native fixture identities using reads and admits every configuration case", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-configuration-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const bodies = {
    "/rest/api/2/project/KEIKO/permissionscheme": { id: 0 },
    "/rest/api/2/permissionscheme/0/permission": { permissions: [{ id: 37 }] },
    "/rest/api/2/project/KEIKO/workflowscheme": { id: 53 },
    "/rest/api/2/project/KEIKO/notificationscheme": { id: 61 },
    "/rest/api/2/issuetypescheme": { schemes: [{ id: "59" }] },
    "/rest/api/2/priorityschemes": { schemes: [{ id: 41 }] },
    "/rest/api/2/screens": { screens: [{ id: 43 }] },
    "/rest/api/2/screens/43/tabs": [{ id: 47 }],
    "/rest/api/2/issueLinkType": { issueLinkTypes: [{ id: "67" }] },
  };
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("GET");
    const path = new URL(url).pathname;
    expect(Object.hasOwn(bodies, path)).toBe(true);
    return new globalThis.Response(JSON.stringify(bodies[path]), { status: 200 });
  });
  const fixture = { issueKeys: ["KEIKO-1"], issueTypeId: "10003" };
  const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  try {
    for (const specification of API_QUALIFICATION_CONFIGURATION_CASES) {
      await specification.prepare?.(context, fixture);
      const operation = jiraOperationForTool(specification.tool);
      expect(operation, specification.tool).toBeDefined();
      expect(
        describeCatalogSchemaMismatch(
          operation.declaration.descriptor.inputSchema,
          specification.arguments(fixture),
        ),
        specification.tool,
      ).toBeUndefined();
    }
    expect(fixture).toMatchObject({
      permissionSchemeId: "0",
      permissionGrantId: "37",
      screenId: "43",
      tabId: "47",
      workflowSchemeId: "53",
    });
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("compares permission holders independently without treating expanded metadata as a grant", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-holder-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new globalThis.Response(
      JSON.stringify({
        permissions: [
          {
            id: 37,
            permission: "BROWSE_PROJECTS",
            holder: {
              type: "group",
              parameter: "synthetic-group",
              group: { name: "synthetic-group" },
            },
          },
        ],
      }),
      { status: 200 },
    ),
  );
  const specification = API_QUALIFICATION_CONFIGURATION_CASES.find(
    ({ tool }) => tool === "jira.permission-grants",
  );
  try {
    const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
    const items = [
      {
        id: "37",
        permission: "BROWSE_PROJECTS",
        holder: { type: "group", parameter: "synthetic-group" },
      },
    ];
    await expect(
      specification.readback(context, { items }, { permissionSchemeId: "0" }),
    ).resolves.toMatchObject({ matched: true });
    native.mockResolvedValueOnce(
      new globalThis.Response(
        JSON.stringify({
          permissions: [{ id: 37, permission: "BROWSE_PROJECTS", holder: { type: "anyone" } }],
        }),
        { status: 200 },
      ),
    );
    await expect(
      specification.readback(context, { items }, { permissionSchemeId: "0" }),
    ).rejects.toThrow("independent native read");
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
