import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import { API_QUALIFICATION_PROPERTY_CASES } from "../testing/jira-chat-lab/api-qualification-property-cases.mjs";

it("compares the production property node list with a separately read native value", async () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-property-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
  const fixture = { issueKeys: ["KEIKO-1"], runId: "synthetic-run" };
  const propertyKey = "keiko-ac7-synthetic-run";
  const value = "Synthetic AC7 synthetic-run";
  const native = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const path = new URL(url).pathname;
    const body = path.endsWith(propertyKey)
      ? { key: propertyKey, value }
      : path.endsWith("/properties")
        ? { keys: [{ key: propertyKey }] }
        : { id: "10000", key: "KEIKO-1" };
    return new globalThis.Response(JSON.stringify(body), { status: 200 });
  });
  try {
    const specification = API_QUALIFICATION_PROPERTY_CASES.find(
      ({ tool }) => tool === "jira.issue-property",
    );
    const context = { actor: "api", session: { ...DEFAULT_LAB_CONNECTION, directory } };
    await expect(
      specification.readback(
        context,
        { propertyKey, items: [{ path: "", kind: "string", textValue: value }] },
        fixture,
      ),
    ).resolves.toMatchObject({ matched: true });
    await expect(
      specification.readback(
        context,
        { propertyKey, items: [{ path: "", kind: "string", textValue: "Different value" }] },
        fixture,
      ),
    ).rejects.toThrow();
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
