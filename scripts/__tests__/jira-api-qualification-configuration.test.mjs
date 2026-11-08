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
import { API_QUALIFICATION_RELEASE_CASES } from "../testing/jira-chat-lab/api-qualification-release-cases.mjs";

it("binds issue and property lifecycle arguments to the real operation contracts", () => {
  const fixture = {
    projectId: "10000",
    issueTypeId: "10003",
    issueKeys: ["KEIKO-1"],
    createdIssueKey: "KEIKO-4",
    commentId: "37",
    worklogId: "41",
    worklogStarted: "2026-11-08T08:00:00.000+0000",
    transitionId: "11",
    runId: "synthetic-run",
    componentId: "71",
    versionId: "81",
    releaseActorKey: "synthetic-admin",
    versionSnapshot: {
      name: "Synthetic version",
      description: "",
      startDate: null,
      releaseDate: null,
      released: false,
      archived: false,
    },
    componentSnapshot: {
      name: "Synthetic component",
      description: "",
      leadUserName: null,
      assigneeType: "PROJECT_DEFAULT",
      archived: false,
      deleted: false,
    },
    linkSuffixes: [],
    linkSnapshots: [],
  };
  for (const specification of [
    ...API_QUALIFICATION_ISSUE_CASES,
    ...API_QUALIFICATION_PROPERTY_CASES,
    ...API_QUALIFICATION_RELEASE_CASES,
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
    "/rest/api/2/notificationscheme": { values: [{ id: 61 }] },
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
    await API_QUALIFICATION_CONFIGURATION_CASES.reduce(async (previous, specification) => {
      await previous;
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
    }, Promise.resolve());
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

it("compares the accessible project type's native key with the product projectTypeKey", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-project-type-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new globalThis.Response(JSON.stringify({ key: "software", formattedKey: "Software" }), {
      status: 200,
    }),
  );
  const specification = API_QUALIFICATION_CONFIGURATION_CASES.find(
    ({ tool }) => tool === "jira.project-type",
  );
  try {
    await expect(
      specification.readback(
        { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } },
        { projectTypeKey: "software", name: "Software" },
        {},
      ),
    ).resolves.toMatchObject({ matched: true });
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["jira.notification-scheme", "jira.project-notification-scheme"])(
  "compares the single %s using its native object and catalog items",
  async (tool) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-notification-"));
    mkdirSync(join(directory, "secrets"));
    writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
    const native = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new globalThis.Response(JSON.stringify({ id: 61, name: "Synthetic notifications" }), {
          status: 200,
        }),
    );
    try {
      const specification = API_QUALIFICATION_CONFIGURATION_CASES.find(
        (entry) => entry.tool === tool,
      );
      await expect(
        specification.readback(
          { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } },
          { items: [{ id: "61", name: "Synthetic notifications" }] },
          { notificationSchemeId: "61" },
        ),
      ).resolves.toMatchObject({ matched: true });
    } finally {
      native.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("compares version-link values using the native JSON member order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-version-link-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const globalId = "keiko-ac7-synthetic-run-a";
  const native = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () =>
        new globalThis.Response(
          JSON.stringify({ link: JSON.stringify({ flag: true, globalId }) }),
          { status: 200 },
        ),
    );
  const specification = API_QUALIFICATION_RELEASE_CASES.find(
    ({ tool }) => tool === "jira.version-remote-link",
  );
  const nodes = [
    { path: "", kind: "object", childCount: 2 },
    { path: "/flag", kind: "boolean", booleanValue: true },
    { path: "/globalId", kind: "string", textValue: globalId },
  ];
  const fixture = { versionId: "81", runId: "synthetic-run", linkSuffixes: ["a"] };
  const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  try {
    await expect(
      specification.readback(
        context,
        {
          items: [
            { globalId, valueNodes: nodes.map((node) => Object.assign(Object.create(null), node)) },
          ],
        },
        fixture,
      ),
    ).resolves.toMatchObject({ matched: true });
    const altered = structuredClone(nodes);
    altered[1].booleanValue = false;
    await expect(
      specification.readback(context, { items: [{ globalId, valueNodes: altered }] }, fixture),
    ).rejects.toThrow();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
