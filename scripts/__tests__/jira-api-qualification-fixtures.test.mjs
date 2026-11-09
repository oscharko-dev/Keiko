import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import {
  dispatchedStatuses,
  missingReleaseCapability,
  observeQualificationFixtures,
  readCase,
} from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import { API_QUALIFICATION_CASES } from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { API_QUALIFICATION_OBSERVATION_CASES } from "../testing/jira-chat-lab/api-qualification-observation-cases.mjs";

it.each(["10.3.26", "10.4.0", "11.2.1", "11.3.13"])(
  "binds a missing search-limit endpoint to the independently observed release %s",
  async (release) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-absent-version-"));
    mkdirSync(join(directory, "secrets"));
    writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
    const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const server = new URL(url).pathname === "/rest/api/2/serverInfo";
      return new globalThis.Response(
        JSON.stringify(
          server
            ? {
                version: release,
                versionNumbers: release.split(".").map(Number),
                deploymentType: "Data Center",
              }
            : {},
        ),
        { status: server ? 200 : 404 },
      );
    });
    const specification = API_QUALIFICATION_OBSERVATION_CASES.find(
      (entry) => entry.tool === "jira.search-max-result-window",
    );
    const context = {
      actor: "api",
      session: { ...DEFAULT_LAB_CONNECTION, directory, jiraVersion: release },
    };
    try {
      if (release.startsWith("10.")) {
        await expect(specification.readback(context, {}, {})).resolves.toMatchObject({
          capabilityAbsent: true,
          status: 404,
          release,
          reason: "absent-in-release-inventory",
        });
        expect(native).toHaveBeenCalledTimes(2);
      } else await expect(specification.readback(context, {}, {})).rejects.toThrow();
    } finally {
      native.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("refuses missing-capability evidence when native serverInfo disagrees with the session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-wrong-release-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const server = new URL(url).pathname === "/rest/api/2/serverInfo";
    return new globalThis.Response(
      JSON.stringify(
        server
          ? {
              version: "11.2.1",
              versionNumbers: [11, 2, 1],
              deploymentType: "Data Center",
            }
          : {},
      ),
      { status: server ? 200 : 404 },
    );
  });
  try {
    const specification = API_QUALIFICATION_OBSERVATION_CASES.find(
      (entry) => entry.tool === "jira.search-max-aggregation-buckets",
    );
    await expect(
      specification.readback(
        { actor: "api", session: { ...DEFAULT_LAB_CONNECTION, directory } },
        {},
        {},
      ),
    ).rejects.toThrow("does not match the session manifest");
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

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

it.each([
  {
    tool: "jira.system-avatars",
    native: { system: [{ id: "1", selected: false }] },
    product: [{ id: "1", category: "system", selected: false }],
  },
  {
    tool: "jira.screens",
    native: { screens: [{ id: 1, name: "Synthetic screen" }] },
    product: [{ id: "1", name: "Synthetic screen" }],
  },
  {
    tool: "jira.create-fields",
    native: { values: [{ fieldId: "summary", name: "Summary", required: true }] },
    product: [{ id: "summary", name: "Summary", required: true }],
  },
  {
    tool: "jira.edit-fields",
    native: { fields: { summary: { name: "Summary", required: true } } },
    product: [{ id: "summary", name: "Summary", required: true }],
  },
])(
  "compares the native $tool wrapper and field identity with the product projection",
  async ({ tool, native: body, product }) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-native-shape-"));
    mkdirSync(join(directory, "secrets"));
    writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
    const native = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new globalThis.Response(JSON.stringify(body), { status: 200 }));
    const specification = [...API_QUALIFICATION_CASES, ...API_QUALIFICATION_OBSERVATION_CASES].find(
      (entry) => entry.tool === tool,
    );
    try {
      await expect(
        specification.readback(
          { actor: "api", session: { ...DEFAULT_LAB_CONNECTION, directory } },
          { items: product },
          { issueTypeId: "10001", issueKeys: ["KEIKO-1"] },
        ),
      ).resolves.toMatchObject({ matched: true });
    } finally {
      native.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("requires independent identity equality even when collection counts match", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-readback-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
  const native = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new globalThis.Response(
        JSON.stringify({ permissions: { BROWSE_PROJECTS: { havePermission: false } } }),
        { status: 200 },
      ),
    );
  const context = { actor: "api", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  const specification = readCase(
    "jira.project-permissions",
    "/rest/api/2/mypermissions",
    ["key", "havePermission"],
    {
      nativeRoot: "permissions",
      productRoot: "permissions",
    },
  );
  try {
    await expect(
      specification.readback(
        context,
        {
          permissions: [{ key: "ADMINISTER", havePermission: false }],
        },
        {},
      ),
    ).rejects.toThrow("independent native read");
    native.mockResolvedValueOnce(
      new globalThis.Response(
        JSON.stringify({
          permissions: { BROWSE_PROJECTS: { havePermission: false } },
        }),
        { status: 200 },
      ),
    );
    await expect(
      specification.readback(
        context,
        {
          permissions: [{ key: "BROWSE_PROJECTS", havePermission: false }],
        },
        {},
      ),
    ).resolves.toMatchObject({ matched: true, assertionCount: 3 });
    native.mockResolvedValueOnce(new globalThis.Response("{}", { status: 404 }));
    await expect(specification.readback(context, {}, {})).rejects.toThrow();
    native.mockResolvedValueOnce(new globalThis.Response("{}", { status: 403 }));
    await expect(specification.readback(context, {}, {})).resolves.toEqual({
      permissionDenied: true,
      status: 403,
    });
    native.mockImplementation(
      async () => new globalThis.Response(JSON.stringify({ issueType: "1" }), { status: 200 }),
    );
    const mapping = readCase(
      "jira.workflow-scheme-issue-type",
      "/rest/api/2/workflowscheme/37/issuetype/1",
      ["issueTypeId"],
      {
        nativeRoot: "single",
        productRoot: "single",
        nativeNames: { issueTypeId: "issueType" },
        optionalFields: ["workflow"],
      },
    );
    await expect(mapping.readback(context, { issueTypeId: "1" }, {})).resolves.toMatchObject({
      matched: true,
    });
    await expect(
      mapping.readback(context, { issueTypeId: "1", workflow: "Invented default" }, {}),
    ).rejects.toThrow();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ["jira.search-error", "10.3.26", true],
  ["jira.move-link-type", "10.3.26", true],
  ["jira.reset-link-type-order", "10.3.26", true],
  ["jira.move-link-type", "10.4.0", false],
  ["jira.search-error", "11.2.1", false],
])("binds %s to the inventory of release %s", async (tool, release, absent) => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-absent-tool-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const server = new URL(url).pathname === "/rest/api/2/serverInfo";
    return new globalThis.Response(
      JSON.stringify(
        server
          ? {
              version: release,
              versionNumbers: release.split(".").map(Number),
              deploymentType: "Data Center",
            }
          : {},
      ),
      { status: server ? 200 : 404 },
    );
  });
  const context = {
    actor: "api",
    session: { ...DEFAULT_LAB_CONNECTION, directory, jiraVersion: release },
    qualificationWitness: { snapshot: () => ({ responses: [{ status: 404 }] }) },
  };
  try {
    const result = await missingReleaseCapability(context, tool, dispatchedStatuses(context));
    if (absent)
      expect(result).toMatchObject({
        capabilityAbsent: true,
        reason: "absent-in-release-inventory",
      });
    else expect(result).toBeUndefined();
    expect(await missingReleaseCapability(context, tool, [200])).toBeUndefined();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
