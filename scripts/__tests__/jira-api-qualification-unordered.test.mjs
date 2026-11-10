import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  API_QUALIFICATION_CASES,
  readCase,
} from "../testing/jira-chat-lab/api-qualification-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

// Jira's own order of the unpaginated project collection (by name), which Keiko pages by key.
const rows = [
  { id: "10401", key: "ISOLATED", name: "Keiko synthetic isolated" },
  { id: "10000", key: "KEIKO", name: "Keiko" },
];

it("compares the unordered native project collection by membership, not by Jira's order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-unordered-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const context = { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
  const native = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new globalThis.Response(JSON.stringify(rows), { status: 200 }));
  try {
    const projects = API_QUALIFICATION_CASES.find((entry) => entry.tool === "jira.projects");
    const keyOrder = [rows[1], rows[0]];
    await expect(projects.readback(context, { items: keyOrder }, {})).resolves.toMatchObject({
      matched: true,
    });
    // A missing, changed or extra project is still a mismatch.
    for (const items of [
      [rows[1]],
      [rows[1], { ...rows[0], name: "Other" }],
      [...keyOrder, { id: "10500", key: "EXTRA", name: "Extra" }],
    ])
      await expect(projects.readback(context, { items }, {})).rejects.toThrow();
    // Every other collection keeps its native order.
    const ordered = readCase("jira.projects", "/rest/api/2/project", ["id", "key", "name"]);
    await expect(ordered.readback(context, { items: keyOrder }, {})).rejects.toThrow();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
