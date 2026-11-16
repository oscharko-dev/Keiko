import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { API_QUALIFICATION_ADMIN_CASES } from "../testing/jira-chat-lab/api-qualification-admin-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
const fixture = {
  runId: "synthetic-run",
  adminActorKey: "actor-key",
  categoryId: "7",
  categorySnapshot: { id: "7", name: "Synthetic category", description: "Synthetic description" },
  adminLinkTypeId: "9",
  adminLinkSnapshot: { id: "9", name: "Synthetic link", inward: "inward", outward: "outward" },
  adminLinkTypes: [{ id: "9", name: "Synthetic link", inward: "inward", outward: "outward" }],
  adminPermissionSchemeId: "11",
  adminPermissionSnapshot: {
    id: "11",
    name: "Synthetic permissions",
    description: "Synthetic description",
    permissions: [],
  },
  adminGrantId: "13",
  adminRoleId: "15",
  adminRoleSnapshot: { id: "15", name: "Synthetic role", description: "Synthetic description" },
  adminRoleActors: [],
  adminRoleUser: { key: "editor-key", name: "keiko-editor" },
  adminGroupUser: { key: "editor-key", name: "keiko-editor" },
  groupMembership: false,
};
it("binds every isolated admin lifecycle to one unique actual native contract", () => {
  const identities = new Set();
  for (const entry of API_QUALIFICATION_ADMIN_CASES) {
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
    if (entry.actor === "admin") expect(entry.administration, entry.tool).toBe(true);
    if (entry.mutation)
      expect(entry).toMatchObject({
        actor: "admin",
        administration: true,
        destructiveAdministration: true,
      });
  }
  expect(identities.size).toBe(27);
});
it("rejects both a mismatched category and an invented successful removal in the independent oracle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-admin-oracle-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  let category = { id: "7", name: "Wrong name", description: "Synthetic category" };
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    expect(options.method).toBe("GET");
    return new globalThis.Response(JSON.stringify(category), { status: 200 });
  });
  const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  try {
    const create = API_QUALIFICATION_ADMIN_CASES.find(
      (e) => e.tool === "jira.create-project-category",
    );
    await expect(
      create.readback(context, { categoryId: "7" }, { runId: "synthetic-run" }),
    ).rejects.toThrow();
    category = {
      id: "7",
      name: "Synthetic AC7 category synthetic-run",
      description: "Synthetic category",
    };
    await expect(
      create.readback(context, { categoryId: "7" }, { runId: "synthetic-run" }),
    ).resolves.toMatchObject({ matched: true });
    const remove = API_QUALIFICATION_ADMIN_CASES.find(
      (e) => e.tool === "jira.delete-project-category",
    );
    category = [category];
    await expect(remove.readback(context, {}, { categoryId: "7" })).rejects.toThrow();
    category = [];
    await expect(remove.readback(context, {}, { categoryId: "7" })).resolves.toMatchObject({
      matched: true,
    });
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("sends the reviewed scheme name with a permission-scheme update because native Jira requires it", () => {
  const selected = API_QUALIFICATION_ADMIN_CASES.find(
    (entry) => entry.tool === "jira.update-permission-scheme",
  );
  expect(selected.arguments(fixture)).toMatchObject({
    name: `Synthetic AC7 permissions ${fixture.runId}`,
    description: "Synthetic permissions revised",
  });
});
